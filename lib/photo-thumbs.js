// lib/photo-thumbs.js — small copies of a job's photos for the job page (2026-10-22,
// D-072 amendment 15).
//
// WHY. GET /service/jobs/{id}/photos was never the slow part — it lists S3 once and hands
// back public links (measured 2026-10-21: 475 photos on SVC a1c7y00000RwICvAAN listed in
// well under three seconds, no presigning). What held the page hostage was the browser
// fetching the ORIGINALS: those 475 photos are 1.45 GB, ~3 MB each. So the photo list now
// carries a `thumbUrl` per photo — a ~400 px JPEG — and the page shows those, opening the
// original only on a click.
//
// WHERE. SUNDIAL/_cache/photo-thumbs/{jobId}/{sha1(photo key)}-400.jpg — under the shared
// `_cache` prefix (lib's report-image cache lives beside it), OUTSIDE every record's own
// folder, so XFiles Pro and the Dropbox mirror never see a thumbnail as a file of the job.
// The original is never touched, moved or re-encoded.
//
// WHEN. At upload (the tech app's photos/confirm and the office's job photos/confirm), and
// by the backfill — POST /service/jobs/{id}/photos/thumbs in rounds, or
// scripts/backfill-photo-thumbs.mjs for every job (the Housecall Pro photos included). A
// photo without a thumb yet is listed with thumbUrl null and the page falls back to the
// original; no page load ever waits on a thumbnail being made.
//
// WHAT. JPEG only (by extension — no read for anything else). Shrunk with lib/image-resize.js
// (pure JS, the same box filter as the report) to a long edge of at most 400 px at quality 80;
// one already that small is copied as-is so every JPEG ends up with a thumb object and the
// backfill never fetches it again.

import { createHash } from "node:crypto";
import { resizeJpegForReport } from "./image-resize.js";
import { publicUrlForKey } from "./file-access.js";

export const THUMB_PREFIX = "SUNDIAL/_cache/photo-thumbs";
export const THUMB_MAX_EDGE = 400;
export const THUMB_JPEG_QUALITY = 80;
/** Below this much Lambda memory a 12 MP decode is an out-of-memory risk: skip, the backfill catches up. */
export const THUMB_MIN_MEMORY_MB = 1024;

/** The folder of one job's thumbnails (trailing slash). */
export function thumbPrefix(jobId) {
  return `${THUMB_PREFIX}/${jobId}/`;
}

/** The thumbnail's key for one photo of a job. */
export function thumbKey(jobId, photoKey) {
  return `${thumbPrefix(jobId)}${createHash("sha1").update(String(photoKey)).digest("hex").slice(0, 16)}-${THUMB_MAX_EDGE}.jpg`;
}

/** Only JPEGs get a thumbnail; decided by the name so nothing else is ever read. */
export function isThumbable(key) {
  return /\.jpe?g$/i.test(String(key || ""));
}

/** Whether this Lambda has the memory to make one inline (AWS sets the env var). */
export function canThumbInline(env = process.env) {
  const mb = Number(env?.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
  return Number.isFinite(mb) && mb >= THUMB_MIN_MEMORY_MB;
}

/**
 * Make one photo's thumbnail. deps: getObject({ key }) → { bytes }, putObject({ key, body,
 * contentType }), resize(bytes, opts) (defaults to lib/image-resize.js). Never throws.
 * @returns {Promise<{ status: "made"|"copied"|"skipped"|"failed", key: string|null }>}
 */
export async function makeThumb(deps, jobId, photoKey) {
  if (!isThumbable(photoKey)) return { status: "skipped", key: null };
  const key = thumbKey(jobId, photoKey);
  try {
    const obj = await deps.getObject({ key: photoKey });
    const resize = deps.resize ?? resizeJpegForReport;
    const r = resize(obj.bytes, { maxEdge: THUMB_MAX_EDGE, quality: THUMB_JPEG_QUALITY, keepUnderBytes: 0, contentType: "image/jpeg" });
    if (r?.resized) {
      await deps.putObject({ key, body: r.bytes, contentType: "image/jpeg" });
      return { status: "made", key };
    }
    // Already within 400 px (or undecodable): the original IS the thumbnail — a copy, so the
    // backfill finds it done. An undecodable one gets no thumb and stays on its original.
    if (r && r.width && Math.max(r.width, r.height) <= THUMB_MAX_EDGE) {
      await deps.putObject({ key, body: obj.bytes, contentType: "image/jpeg" });
      return { status: "copied", key };
    }
    return { status: "failed", key: null };
  } catch (e) {
    console.error(`thumb: ${photoKey}: ${e?.message || e}`);
    return { status: "failed", key: null };
  }
}

/**
 * Put `thumbUrl` on each photo: the thumbnail's public URL when it exists in `thumbKeys`
 * (a Set of keys, from one listing of the job's thumb folder), else null. Pure.
 */
export function withThumbUrls(photos, jobId, thumbKeys) {
  return (photos || []).map((p) => {
    const k = thumbKey(jobId, p.key);
    return { ...p, thumbUrl: thumbKeys?.has(k) ? publicUrlForKey(k) : null };
  });
}

/**
 * The backfill: make the missing thumbnails for these photos until the time budget runs out.
 * `existing` is the Set of thumb keys already there. Returns the tally and how many remain.
 */
export async function backfillThumbs(deps, jobId, photos, existing, { budgetMs = 20000, now = () => Date.now() } = {}) {
  const start = now();
  const tally = { made: 0, copied: 0, skipped: 0, failed: 0, already: 0, remaining: 0 };
  const todo = [];
  for (const p of photos || []) {
    if (!isThumbable(p.key)) tally.skipped += 1;
    else if (existing?.has(thumbKey(jobId, p.key))) tally.already += 1;
    else todo.push(p);
  }
  for (let i = 0; i < todo.length; i++) {
    if (now() - start > budgetMs) {
      tally.remaining = todo.length - i;
      break;
    }
    const r = await makeThumb(deps, jobId, todo[i].key);
    tally[r.status] += 1;
  }
  return tally;
}
