// lib/cache-touch.js — "touch" a cached report copy so the reports' orientation check trusts it
// (2026-11-05, scripts/fix-photo-orientation.mjs).
//
// WHY. Both reports re-read 64 KB of a photo's original whenever its cached 1,600 px copy is
// older than ORIENTATION_FIX_AT (lib/image-resize.js cachedCopyNeedsRemake). For an UPRIGHT
// photo that copy is already right and is never rewritten, so the read would repeat on every
// report request for ever. The repair script touches such copies instead: an S3 copy-to-self
// with the same metadata and headers, which changes nothing but LastModified — after that the
// check trusts the copy without a read. Only under SUNDIAL/_cache/; the bytes are never changed.

import { CopyObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { ORIENTATION_FIX_AT } from "./image-resize.js";

/** Whether a cached copy's LastModified is before the orientation fix (unknown counts as before). */
export function predatesOrientationFix(lastModified, fixAt = ORIENTATION_FIX_AT) {
  const t = lastModified ? new Date(lastModified).getTime() : NaN;
  return !(Number.isFinite(t) && t >= Date.parse(fixAt));
}

/**
 * Copy an object onto itself, keeping its metadata and headers, to bump LastModified. S3 refuses a
 * copy-to-self that changes nothing, so the directive is REPLACE with the object's OWN values,
 * read first with a HEAD.
 */
export async function touchObject(s3, bucket, key) {
  if (!String(key).startsWith("SUNDIAL/_cache/")) throw new Error(`refusing to touch outside the cache: ${key}`);
  const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const input = {
    Bucket: bucket,
    Key: key,
    CopySource: `${bucket}/${String(key).split("/").map(encodeURIComponent).join("/")}`,
    MetadataDirective: "REPLACE",
    Metadata: h.Metadata ?? {},
    ContentType: h.ContentType ?? "image/jpeg",
  };
  for (const [from, to] of [["CacheControl", "CacheControl"], ["ContentDisposition", "ContentDisposition"], ["ContentEncoding", "ContentEncoding"]]) if (h[from]) input[to] = h[from];
  await s3.send(new CopyObjectCommand(input));
  return input;
}
