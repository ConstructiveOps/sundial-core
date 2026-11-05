// scripts/fix-photo-orientation.mjs — re-make the cached copies of portrait phone photos that were
// cached SIDEWAYS (2026-11-05).
//
//   node scripts/fix-photo-orientation.mjs                          # DRY RUN: counts, writes nothing
//   node scripts/fix-photo-orientation.mjs --job a1c7y00000SDkUmAAL --apply   # one job
//   node scripts/fix-photo-orientation.mjs --apply                  # every job (resumable)
//
// WHY. Until 2026-11-05 lib/image-resize.js ignored the EXIF orientation tag, so a portrait phone
// photo's ~400 px thumbnail (SUNDIAL/_cache/photo-thumbs/) and its 1,600 px report copy
// (SUNDIAL/_cache/report-images/, both reports, since 2026-10-12) were stored sideways. New
// copies are made upright; this repairs the ones already there, in place, so the grids keep
// their thumbnails and the next report PDF reads an upright copy.
//
// WHAT IT READS. The jobs that have anything in either cache (listed from S3 itself). For each,
// every JPEG under SUNDIAL/{jobId}/photos/ that has a thumbnail or a report copy — only the
// first 64 KB of the original (a range GET; the EXIF block is at the front) to read its
// orientation. Most photos are orientation 1 and are skipped.
//
// WHAT IT WRITES (--apply only). For a photo whose orientation is not 1: the whole original is
// read once and its EXISTING cached copies are re-made upright with lib/image-resize.js, at the
// SAME keys (a cache entry that does not exist is not created). Each rewritten object carries
// S3 metadata `sundial-orientation: upright`, which is how a re-run knows it is done
// (resumable: a marked copy is skipped). Writes ONLY under SUNDIAL/_cache/; the originals are
// never written, moved or re-encoded. Nothing touches Salesforce or Supabase.
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a stop must be seen.

import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { S3_BUCKET, S3_REGION } from "../lib/file-access.js";
import { jpegOrientation, resizeJpegForReport } from "../lib/image-resize.js";
import { THUMB_MAX_EDGE, THUMB_JPEG_QUALITY, thumbKey, thumbPrefix, THUMB_PREFIX } from "../lib/photo-thumbs.js";
import { REPORT_IMAGE_CACHE_PREFIX, reportImageCacheKey, reportImageCachePrefix } from "../lib/photo-report-document.js";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const APPLY = args.includes("--apply");
const ONLY = opt("--job");
const HEAD_BYTES = 64 * 1024;
const CONCURRENCY = 16;
const MARK = "sundial-orientation"; // S3 user metadata (x-amz-meta-sundial-orientation)

const s3 = new S3Client({ region: S3_REGION });

async function list(prefix, delimiter) {
  const keys = [];
  const prefixes = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, Delimiter: delimiter, ContinuationToken }));
    for (const o of page.Contents || []) if (o.Key && !o.Key.endsWith("/")) keys.push(o.Key);
    for (const p of page.CommonPrefixes || []) prefixes.push(p.Prefix);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return { keys, prefixes };
}

async function getBytes(key, range) {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, ...(range ? { Range: range } : {}) }));
  return new Uint8Array(await r.Body.transformToByteArray());
}

async function isMarked(key) {
  const h = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return h.Metadata?.[MARK] === "upright";
}

async function put(key, body) {
  if (!key.startsWith("SUNDIAL/_cache/")) throw new Error(`refusing to write outside the cache: ${key}`);
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: "image/jpeg", Metadata: { [MARK]: "upright" } }));
}

/** Run fn over items, CONCURRENCY at a time. */
async function pool(items, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })
  );
}

async function jobIds() {
  if (ONLY) return [ONLY];
  const ids = new Set();
  for (const root of [`${THUMB_PREFIX}/`, `${REPORT_IMAGE_CACHE_PREFIX}/`]) {
    for (const p of (await list(root, "/")).prefixes) ids.add(p.slice(root.length).replace(/\/$/, ""));
  }
  return [...ids].filter(Boolean).sort();
}

const jobs = await jobIds();
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${jobs.length} job(s) with cached photo copies`);
const total = { scanned: 0, rotated: 0, toRegenerate: 0, alreadyFixed: 0, regenerated: 0, failed: 0 };
const byOrientation = {};

for (const [i, jobId] of jobs.entries()) {
  const photos = (await list(`SUNDIAL/${jobId}/photos/`)).keys.filter((k) => /\.jpe?g$/i.test(k));
  const thumbs = new Set((await list(thumbPrefix(jobId))).keys);
  const copies = new Set((await list(reportImageCachePrefix(jobId))).keys);
  const cached = photos
    .map((key) => ({ key, targets: [thumbs.has(thumbKey(jobId, key)) && "thumb", copies.has(reportImageCacheKey(jobId, key)) && "copy"].filter(Boolean) }))
    .filter((p) => p.targets.length);
  const tally = { scanned: cached.length, rotated: 0, toRegenerate: 0, alreadyFixed: 0, regenerated: 0, failed: 0 };

  await pool(cached, async (p) => {
    try {
      const o = jpegOrientation(await getBytes(p.key, `bytes=0-${HEAD_BYTES - 1}`));
      byOrientation[o] = (byOrientation[o] || 0) + 1;
      if (o === 1) return;
      tally.rotated++;
      const keys = p.targets.map((t) => (t === "thumb" ? thumbKey(jobId, p.key) : reportImageCacheKey(jobId, p.key)));
      const todo = [];
      for (const k of keys) {
        if (await isMarked(k)) tally.alreadyFixed++;
        else todo.push(k);
      }
      tally.toRegenerate += todo.length;
      if (!APPLY || !todo.length) return;
      const original = await getBytes(p.key);
      for (const k of todo) {
        const isThumb = k.startsWith(`${THUMB_PREFIX}/`);
        const r = isThumb
          ? resizeJpegForReport(original, { maxEdge: THUMB_MAX_EDGE, quality: THUMB_JPEG_QUALITY, keepUnderBytes: 0, contentType: "image/jpeg" })
          : resizeJpegForReport(original, { contentType: "image/jpeg" });
        if (!r?.resized) {
          tally.failed++;
          console.log(`  FAILED (could not decode) ${p.key}`);
          continue;
        }
        await put(k, r.bytes);
        tally.regenerated++;
      }
    } catch (e) {
      tally.failed++;
      console.log(`  FAILED ${p.key}: ${e?.message || e}`);
    }
  });

  for (const k of Object.keys(total)) total[k] += tally[k];
  console.log(
    `[${i + 1}/${jobs.length}] ${jobId}: ${tally.scanned} cached photo(s), ${tally.rotated} turned, ${tally.toRegenerate} cache object(s) to re-make, ${tally.alreadyFixed} already fixed` +
      (APPLY ? `, re-made ${tally.regenerated}, failed ${tally.failed}` : tally.failed ? `, failed ${tally.failed}` : "")
  );
}

console.log(
  `\n${APPLY ? "DONE" : "DRY RUN"} — photos scanned ${total.scanned}, turned (orientation ≠ 1) ${total.rotated}, cache objects to re-make ${total.toRegenerate}, already fixed ${total.alreadyFixed}` +
    (APPLY ? `, re-made ${total.regenerated}` : "") +
    `, failed ${total.failed}`
);
console.log(`orientations seen: ${JSON.stringify(byOrientation)}`);
if (!APPLY) console.log("Nothing written. Re-run with --apply to re-make them.");
process.exitCode = total.failed ? 1 : 0;
