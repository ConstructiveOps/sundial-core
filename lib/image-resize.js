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
 * The photo as the PDF should embed it. Returns { bytes, contentType, width, height,
 * resized } — `resized: false` with the input untouched when it is small enough, not a
 * JPEG, or cannot be decoded (never throws for a bad photo: the painter's placeholder is
 * the right answer, not a failed send).
 */
export function resizeJpegForReport(bytes, { maxEdge = REPORT_MAX_EDGE, quality = REPORT_JPEG_QUALITY, keepUnderBytes = KEEP_UNDER_BYTES, contentType = null } = {}) {
  const b = toU8(bytes);
  const dims = jpegDimensions(b);
  if (!dims) return { bytes: b, contentType, width: null, height: null, resized: false };
  const f = shrinkFactor(dims, maxEdge);
  if (f === 1 && b.length <= keepUnderBytes) return { bytes: b, contentType: "image/jpeg", ...dims, resized: false };
  try {
    const decoded = jpeg.decode(b, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: MAX_DECODE_MB });
    const small = f === 1 ? rgbToRgba(decoded.data, decoded.width, decoded.height) : boxDownscaleRgb(decoded.data, decoded.width, decoded.height, f);
    const encoded = jpeg.encode({ data: small.data, width: small.width, height: small.height }, quality);
    return { bytes: new Uint8Array(encoded.data), contentType: "image/jpeg", width: small.width, height: small.height, resized: true };
  } catch (e) {
    console.error("image-resize: decode/encode failed, embedding the original:", e?.message || e);
    return { bytes: b, contentType: "image/jpeg", ...dims, resized: false };
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
