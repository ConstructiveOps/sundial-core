// lib/image-resize.js — shrink a phone photo for a PDF (2026-10-12).
//
// WHY. The job report embeds each section's photo bytes as-is (pdf-lib's embedJpg stores the
// JPEG untouched). A tech's phone photo is 3–7 MB and 12 megapixels; an HCP-migrated one the
// same. A report with eight of them meant ~50 MB read from S3, a ~50 MB PDF built in memory,
// written back, and nothing to attach (over the 8 MB email cap) — and on 2026-10-12 Harmon's
// sends came back "internal server error" (the Lambda out of memory) and "timeout" (API
// Gateway's 29-second ceiling). A page of the PDF is 500 points wide: a 1,600-pixel photo is
// already more than it can show.
//
// HOW. Pure JavaScript (the Lambda is one esbuild bundle — no native sharp): `jpeg-js`
// decodes, an integer-factor box filter averages the pixels down (fast, no ringing), jpeg-js
// encodes at quality 80. A 12-megapixel photo takes ~2 s and comes out ~150–250 KB; one
// that is already small is returned untouched (the dimensions are read from the JPEG
// header, no decode). PNG / HEIC / anything else is returned as it came — the PDF painter
// already places a labelled box for what it cannot embed.
//
// ORIENTATION (2026-11-05). A phone stores a portrait photo as landscape pixels plus an EXIF
// tag (0x0112) saying "turn me". A browser obeys the tag; jpeg-js and pdf-lib's embedJpg do
// not, and the encoder writes no EXIF — so every portrait photo came out SIDEWAYS in the
// report PDFs (since 2026-10-12) and the job-page thumbnails. Now the tag is read from the
// APP1 segment without decoding, the decoded pixels are turned upright (orientations 2–8)
// BEFORE the box filter, and the output carries no EXIF: its pixels are the truth. A photo
// that is already small is returned untouched only when its orientation is 1 — copied as it
// is, a turned photo is upright in a browser and sideways in a PDF.

import jpeg from "jpeg-js";

export const REPORT_MAX_EDGE = 1600; // pixels on the long side after the shrink
export const REPORT_JPEG_QUALITY = 80;
/** Under this many bytes AND within the edge limit, a JPEG is embedded as it is. */
export const KEEP_UNDER_BYTES = 1.5 * 1024 * 1024;
/** jpeg-js refuses to decode above this — a 12 MP photo needs ~100 MB; leave headroom. */
const MAX_DECODE_MB = 768;

/** True for JPEG bytes (SOI marker). */
export function isJpeg(bytes) {
  const b = toU8(bytes);
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

const toU8 = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));

/**
 * Width / height from a JPEG's SOF marker without decoding it. null when it is not a
 * JPEG or the header is malformed.
 */
export function jpegDimensions(bytes) {
  const b = toU8(bytes);
  if (!isJpeg(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * The EXIF orientation (1–8) of a JPEG, read from its APP1 "Exif" segment — TIFF header,
 * IFD0, tag 0x0112, either byte order — without decoding. 1 when there is no tag, the bytes
 * are not a JPEG, or anything is malformed / cut off (a 64 KB range read is enough).
 */
export function jpegOrientation(bytes) {
  const b = toU8(bytes);
  if (!isJpeg(b)) return 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return 1; // end of image / start of scan: no EXIF before the pixels
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return 1;
    const isExif = marker === 0xe1 && len >= 8 && i + 10 <= b.length && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0;
    if (isExif) {
      const o = exifOrientation(b, i + 10, Math.min(b.length, i + 2 + len));
      if (o) return o;
    }
    i += 2 + len;
  }
  return 1;
}

/** Orientation from the TIFF block at `t` (ending at `end`); null when absent or malformed. */
function exifOrientation(b, t, end) {
  if (t + 8 > end) return null;
  const le = b[t] === 0x49 && b[t + 1] === 0x49; // "II" little-endian
  const be = b[t] === 0x4d && b[t + 1] === 0x4d; // "MM" big-endian
  if (!le && !be) return null;
  const u16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
  const u32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
  if (u16(t + 2) !== 42) return null;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return null;
    if (u16(e) !== 0x0112) continue;
    const type = u16(e + 2);
    const v = type === 3 ? u16(e + 8) : type === 4 ? u32(e + 8) : null; // SHORT (the spec) or LONG (seen in the wild)
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

/**
 * Turn decoded RGB (3 bytes / pixel) upright for an EXIF orientation: 2 mirror, 3 180°,
 * 4 flip, 5 transpose, 6 90° clockwise, 7 transverse, 8 90° counter-clockwise. Orientation 1
 * (or anything unknown) returns the input as it is. 5–8 swap width and height.
 */
export function orientRgb(rgb, width, height, orientation) {
  if (!(orientation >= 2 && orientation <= 8)) return { data: rgb, width, height };
  const swap = orientation >= 5;
  const ow = swap ? height : width;
  const oh = swap ? width : height;
  const out = new Uint8Array(ow * oh * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx;
      let ny;
      switch (orientation) {
        case 2: nx = width - 1 - x; ny = y; break;
        case 3: nx = width - 1 - x; ny = height - 1 - y; break;
        case 4: nx = x; ny = height - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = height - 1 - y; ny = x; break;
        case 7: nx = height - 1 - y; ny = width - 1 - x; break;
        default: nx = y; ny = width - 1 - x; // 8
      }
      const s = (y * width + x) * 3;
      const d = (ny * ow + nx) * 3;
      out[d] = rgb[s];
      out[d + 1] = rgb[s + 1];
      out[d + 2] = rgb[s + 2];
    }
  }
  return { data: out, width: ow, height: oh };
}

/** The integer factor that brings the long edge within `maxEdge` (1 = already within). */
export function shrinkFactor({ width, height }, maxEdge = REPORT_MAX_EDGE) {
  const long = Math.max(width, height);
  return long <= maxEdge ? 1 : Math.ceil(long / maxEdge);
}

/**
 * Average every f×f block of an RGB (3 bytes / pixel) image into one pixel. Returns RGBA
 * (what jpeg-js's encoder reads). Edge blocks that are narrower than f are averaged over
 * what is there.
 */
export function boxDownscaleRgb(rgb, width, height, f) {
  const ow = Math.max(1, Math.floor(width / f));
  const oh = Math.max(1, Math.floor(height / f));
  const out = new Uint8Array(ow * oh * 4);
  const area = f * f;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * f;
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * f;
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let y = y0; y < y0 + f; y++) {
        let p = (y * width + x0) * 3;
        for (let x = 0; x < f; x++) {
          r += rgb[p];
          g += rgb[p + 1];
          bl += rgb[p + 2];
          p += 3;
        }
      }
      const o = (oy * ow + ox) * 4;
      out[o] = (r / area) | 0;
      out[o + 1] = (g / area) | 0;
      out[o + 2] = (bl / area) | 0;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: ow, height: oh };
}

/**
 * The photo as the PDF should embed it — upright, whatever its EXIF said. Returns { bytes,
 * contentType, width, height, resized, orientation } — `resized: false` with the input
 * untouched when it is small enough AND already upright (orientation 1), not a JPEG, or
 * cannot be decoded (never throws for a bad photo: the painter's placeholder is
 * the right answer, not a failed send).
 */
export function resizeJpegForReport(bytes, { maxEdge = REPORT_MAX_EDGE, quality = REPORT_JPEG_QUALITY, keepUnderBytes = KEEP_UNDER_BYTES, contentType = null } = {}) {
  const b = toU8(bytes);
  const dims = jpegDimensions(b);
  if (!dims) return { bytes: b, contentType, width: null, height: null, resized: false };
  const orientation = jpegOrientation(b);
  const f = shrinkFactor(dims, maxEdge);
  if (f === 1 && b.length <= keepUnderBytes && orientation === 1) return { bytes: b, contentType: "image/jpeg", ...dims, resized: false, orientation };
  try {
    const decoded = jpeg.decode(b, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: MAX_DECODE_MB });
    const upright = orientRgb(decoded.data, decoded.width, decoded.height, orientation); // turn first, THEN shrink
    const small = f === 1 ? rgbToRgba(upright.data, upright.width, upright.height) : boxDownscaleRgb(upright.data, upright.width, upright.height, f);
    const encoded = jpeg.encode({ data: small.data, width: small.width, height: small.height }, quality); // no EXIF written: the pixels are upright
    return { bytes: new Uint8Array(encoded.data), contentType: "image/jpeg", width: small.width, height: small.height, resized: true, orientation };
  } catch (e) {
    console.error("image-resize: decode/encode failed, embedding the original:", e?.message || e);
    return { bytes: b, contentType: "image/jpeg", ...dims, resized: false, orientation };
  }
}

function rgbToRgba(rgb, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    out[o] = rgb[i];
    out[o + 1] = rgb[i + 1];
    out[o + 2] = rgb[i + 2];
    out[o + 3] = 255;
  }
  return { data: out, width, height };
}

// --- cached copies made before the orientation fix (2026-11-05) ------------------------------
// The repair script (scripts/fix-photo-orientation.mjs) re-makes the sideways copies already in
// the cache, but it takes hours. So the report path heals itself: a cached copy written BEFORE
// the fix was deployed is re-made when its original is turned (EXIF orientation ≠ 1), and kept
// when the original is upright. A copy written since the fix (or by the repair) is trusted
// without reading anything.

/** When the orientation fix went live (sundial-service-estimate deploy, UTC). */
export const ORIENTATION_FIX_AT = "2026-11-05T19:56:28Z";
/** The EXIF block is at the front of a JPEG: this much of the original is enough to read it. */
export const ORIENTATION_HEAD_BYTES = 64 * 1024;

/**
 * Whether a cached copy must be re-made. `lastModified` is the copy's S3 LastModified (Date or
 * ISO string; unknown counts as old); `readOriginalHead()` resolves the first
 * ORIENTATION_HEAD_BYTES of the ORIGINAL and is only called for an old copy. A failed read
 * keeps the copy (a report is never held up by this check).
 */
export async function cachedCopyNeedsRemake(lastModified, readOriginalHead) {
  const t = lastModified ? new Date(lastModified).getTime() : NaN;
  if (Number.isFinite(t) && t >= Date.parse(ORIENTATION_FIX_AT)) return false;
  try {
    return jpegOrientation(await readOriginalHead()) !== 1;
  } catch (e) {
    console.error("image-resize: orientation check failed, keeping the cached copy:", e?.message || e);
    return false;
  }
}
