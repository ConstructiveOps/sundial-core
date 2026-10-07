// lib/hcp-media.js — the photos and documents on Harmon's Housecall Pro jobs, into the
// job's S3 folder in Sundial (2026-10-05; docs/migration.md → "The attachments gap").
//
// HCP's public API cannot list a job's attachments. Its signed-in web app can: the job
// page calls
//   GET https://pro.housecallpro.com/api/customers/{cus_id}/attachments
//       ?attachable_uuid={job_id}&attachable_type=Job&page=1&page_size=100
// with nothing but the browser's login cookie, and every row carries a 1-hour signed S3
// URL for the original file (`attachment_file_url`; reconnaissance 2026-10-05 on Ben's
// session: 40 random jobs → 551 files / 1.6 GB, so ~31,000 files / ~90 GB over the 2,265
// jobs; jpeg 97%, a few PDFs and mp4s; up to 59 per job, never a second page at 100).
//
// What this module does, for one job: list → for each file, read it from the signed URL
// and write it to the job's folder in OUR bucket → register the `sundial_file_metadata`
// row the Files tab reads. Photos (image/*, video/*) go to `SUNDIAL/{jobId}/photos/hcp/`,
// the pseudo-call folder the job page shows as "Housecall Pro"; everything else goes to
// `SUNDIAL/{jobId}/` beside the office's documents. Idempotent: a target that already
// exists at the same size is skipped (HeadObject), a metadata row that exists is not
// inserted again — the Lambda can be run twice, stopped and resumed.
//
// The cookie is Ben's HCP login, copied by Tim into Secrets Manager `sundial/hcp` as
// `webCookie` (the whole `cookie:` request-header value). It is read by the Lambda /
// the script through getSecret, never from a file, never logged. Undocumented endpoints
// change without notice: this lives only as long as the migration.
//
// Pure where it can be: the client, the target-key rules and the per-job plan take their
// I/O through `deps` so the tests run with fakes.

import { buildKey, findFileMetadataByKey, registerFileMetadata, sanitizeFileName } from "./file-access.js";

export const HCP_WEB_BASE = "https://pro.housecallpro.com";
export const HCP_WEB_COOKIE_KEY = "webCookie"; // in Secrets Manager `sundial/hcp`
export const PHOTO_FOLDER = "hcp"; // SUNDIAL/{jobId}/photos/hcp/… — the "Housecall Pro" group on the job page
export const FILE_CATEGORY = "Migrated from Housecall Pro";
export const UPLOADER_NAME = "Housecall Pro migration";
export const PAGE_SIZE = 100;
/** Files above this are listed and reported, never copied through a Lambda's memory. */
export const MAX_FILE_BYTES = 900 * 1024 * 1024;

const s = (v) => (v == null ? "" : String(v).trim());
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => Math.min(30000, 1000 * 2 ** (attempt - 1));
const MAX_ATTEMPTS = 5;

/**
 * The HCP web client: GET with the login cookie, JSON back. Retries 429 / 5xx / network
 * errors with backoff; a 401 / 403 is returned as-is (the cookie has expired — the caller
 * stops and says so). `minGapMs` paces the calls like the API client does.
 */
export function createHcpWebClient({ cookie, baseUrl = HCP_WEB_BASE, fetchImpl = (u, i) => fetch(u, i), sleep = sleepReal, minGapMs = 200, log = () => {} } = {}) {
  if (!s(cookie)) throw new Error("createHcpWebClient: cookie is required (Secrets Manager sundial/hcp → webCookie)");
  let lastAt = 0;
  const stats = { requests: 0, retries: 0, statuses: {} };
  async function throttle() {
    const wait = lastAt + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  }
  async function getJson(path, query = {}) {
    const u = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query)) if (v != null && v !== "") u.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      await throttle();
      stats.requests++;
      let res;
      try {
        res = await fetchImpl(u.toString(), {
          headers: {
            Cookie: cookie,
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
          },
        });
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) throw e;
        stats.retries++;
        log(`network error on ${path} (${e?.message || e}); retry ${attempt}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      stats.statuses[res.status] = (stats.statuses[res.status] || 0) + 1;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        stats.retries++;
        const ra = Number(res.headers?.get?.("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt));
        continue;
      }
      let body = null;
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text.slice(0, 300) };
      }
      return { status: res.status, body };
    }
  }
  /** Every attachment on one job, oldest first. Throws `{ code: "SESSION_EXPIRED" }` on a 401 / 403. */
  async function listJobAttachments({ customerId, jobId }) {
    const out = [];
    for (let page = 1; ; page++) {
      const { status, body } = await getJson(`/api/customers/${encodeURIComponent(customerId)}/attachments`, {
        page,
        page_size: PAGE_SIZE,
        attachable_uuid: jobId,
        attachable_type: "Job",
        sort_by: "created_at",
        sort_direction: "asc",
      });
      if (status === 401 || status === 403) throw Object.assign(new Error(`HCP web session refused (${status}) — the cookie has expired; copy a fresh one into sundial/hcp`), { code: "SESSION_EXPIRED", status });
      if (status === 404) return out; // the customer is gone in HCP
      if (status !== 200 || !body || !Array.isArray(body.data)) throw Object.assign(new Error(`HCP attachments list ${status} for ${jobId}`), { code: "LIST_FAILED", status });
      for (const a of body.data) out.push(attachmentFromRow(a));
      if (body.data.length === 0 || page >= Number(body.total_pages_count || 1)) break;
    }
    return out.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.id.localeCompare(b.id));
  }
  return { getJson, listJobAttachments, stats };
}

/** The fields this migration keeps from one HCP attachment row. */
export function attachmentFromRow(a) {
  return {
    id: s(a.id),
    fileName: s(a.file_name) || s(a.file_file_name) || s(a.id),
    contentType: s(a.file_type) || s(a.file_content_type) || "application/octet-stream",
    size: Number(a.file_file_size) || null,
    uploadedAt: s(a.uploaded_at) || s(a.file_updated_at) || "",
    description: s(a.description) || null,
    url: s(a.attachment_file_url) || s(a.download_url) || null, // signed, 1 hour
  };
}

export const isPhoto = (contentType) => /^(image|video)\//i.test(s(contentType));

/**
 * The S3 key for each attachment on one job — deterministic across runs, so a re-run
 * finds its own files. Photos under `photos/hcp/`, documents at the job root. Two
 * attachments with the same name on one job: the second (by upload time) gets the
 * attachment id's tail before the extension (`IMG_0001-3bb6.jpeg`).
 */
export function planKeys(sfJobId, attachments) {
  const seen = new Map();
  return attachments.map((a) => {
    let name = sanitizeFileName(a.fileName) || `${a.id}.bin`;
    const n = (seen.get(name.toLowerCase()) || 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) {
      const dot = name.lastIndexOf(".");
      const tail = a.id.slice(-4);
      name = dot > 0 ? `${name.slice(0, dot)}-${tail}${name.slice(dot)}` : `${name}-${tail}`;
    }
    const photo = isPhoto(a.contentType);
    return { ...a, photo, key: photo ? `${buildKey(sfJobId, "photos")}/${PHOTO_FOLDER}/${name}` : buildKey(sfJobId, name), targetName: name, subfolder: photo ? `photos/${PHOTO_FOLDER}` : null };
  });
}

/**
 * Copy one job's attachments. `deps`:
 *   client        createHcpWebClient()
 *   headObject(key) → { size } | null      (does the target exist already)
 *   putObject({ key, body, contentType, size })
 *   fetchImpl(url) → Response               (the signed S3 URL; no cookie)
 *   supabase      the service-role client (metadata rows), or null to skip rows
 *   log(msg)
 * Returns { jobId, sfJobId, files: [{ id, key, size, status: copied|exists|skipped|failed, error? }], listed, copied, bytes }.
 * `dryRun` lists and plans, copies nothing.
 */
export async function copyJobMedia({ hcpJobId, hcpCustomerId, sfJobId, tenantId, dryRun = false, deps }) {
  const { client, headObject, putObject, fetchImpl = (u) => fetch(u), supabase = null, log = () => {} } = deps;
  const attachments = await client.listJobAttachments({ customerId: hcpCustomerId, jobId: hcpJobId });
  const planned = planKeys(sfJobId, attachments);
  const out = { hcpJobId, sfJobId, listed: planned.length, copied: 0, exists: 0, skipped: 0, failed: 0, bytes: 0, files: [] };
  for (const f of planned) {
    const row = { id: f.id, key: f.key, name: f.targetName, size: f.size, contentType: f.contentType, photo: f.photo, status: "planned" };
    out.files.push(row);
    if (dryRun) continue;
    try {
      if (f.size != null && f.size > MAX_FILE_BYTES) {
        row.status = "skipped";
        row.error = `too large for the Lambda (${f.size} bytes)`;
        out.skipped++;
        continue;
      }
      const head = await headObject(f.key);
      if (head && (f.size == null || head.size === f.size)) {
        row.status = "exists";
        out.exists++;
      } else {
        if (!f.url) throw new Error("no signed url on the row");
        const res = await fetchImpl(f.url);
        if (!res.ok) throw new Error(`download ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (f.size != null && body.length !== f.size) log(`${f.key}: HCP said ${f.size} bytes, got ${body.length}`);
        await putObject({ key: f.key, body, contentType: f.contentType, size: body.length });
        row.status = "copied";
        row.size = body.length;
        out.copied++;
        out.bytes += body.length;
      }
      if (supabase) await ensureMetadata(supabase, { f, tenantId, sfJobId });
    } catch (e) {
      row.status = "failed";
      row.error = String(e?.message || e).slice(0, 200);
      out.failed++;
      log(`${f.key}: ${row.error}`);
    }
  }
  return out;
}

/** The Files-tab row for one copied file, once. */
export async function ensureMetadata(supabase, { f, tenantId, sfJobId }) {
  if (await findFileMetadataByKey(supabase, f.key)) return false;
  await registerFileMetadata(supabase, {
    s3Key: f.key,
    fileName: f.targetName,
    tenantId,
    sfRecordId: sfJobId,
    sfObjectType: "job",
    uploadedByUserId: null,
    uploadedByUserName: UPLOADER_NAME,
    fileSizeBytes: f.size,
    mimeType: f.contentType,
    category: f.photo ? "photo" : FILE_CATEGORY,
    description: [f.description, f.uploadedAt ? `Uploaded to HCP ${f.uploadedAt.slice(0, 10)}` : ""].filter(Boolean).join(" — ").slice(0, 255) || null,
    subfolder: f.subfolder,
  });
  return true;
}

/**
 * Run a batch of jobs until the list is done or `deadlineMs` (epoch) is near — the
 * Lambda's clock. Returns { results, done, remaining } so the driver resumes from
 * `remaining`. A SESSION_EXPIRED stops everything at once.
 */
export async function copyJobsMedia(jobs, { tenantId, dryRun, deps, deadlineMs = Infinity, now = () => Date.now() }) {
  const results = [];
  let i = 0;
  for (; i < jobs.length; i++) {
    if (now() > deadlineMs) break;
    const j = jobs[i];
    try {
      results.push(await copyJobMedia({ ...j, tenantId, dryRun, deps }));
    } catch (e) {
      if (e?.code === "SESSION_EXPIRED") return { results, done: i, remaining: jobs.slice(i), error: e.code, message: e.message };
      results.push({ hcpJobId: j.hcpJobId, sfJobId: j.sfJobId, listed: 0, copied: 0, exists: 0, skipped: 0, failed: 1, bytes: 0, files: [], error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { results, done: i, remaining: jobs.slice(i) };
}
