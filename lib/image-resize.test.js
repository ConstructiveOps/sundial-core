// lib/image-resize.js — the report PDF's photos, shrunk for the page (2026-10-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { markedPhoto, withOrientation } from "./jpeg-test-fixtures.js";
import { KEEP_UNDER_BYTES, boxDownscaleRgb, isJpeg, jpegDimensions, jpegOrientation, orientRgb, resizeJpegForReport, shrinkFactor } from "./image-resize.js";

function photo(w, h, quality = 90) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 255) / w;
      data[i + 1] = (y * 255) / h;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, quality).data);
}

test("jpegDimensions reads the header without decoding; non-JPEG bytes are null", () => {
  assert.deepEqual(jpegDimensions(photo(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(jpegDimensions(photo(31, 17)), { width: 31, height: 17 });
  assert.equal(jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null); // PNG
  assert.equal(jpegDimensions(new Uint8Array()), null);
  assert.equal(isJpeg(photo(8, 8)), true);
  assert.equal(isJpeg(new Uint8Array([1, 2, 3, 4])), false);
});

test("shrinkFactor: 1 within the edge limit, else the integer that brings the long edge under it", () => {
  assert.equal(shrinkFactor({ width: 1600, height: 1200 }), 1);
  assert.equal(shrinkFactor({ width: 4032, height: 3024 }), 3); // → 1344 × 1008
  assert.equal(shrinkFactor({ width: 3024, height: 4032 }), 3); // portrait the same
  assert.equal(shrinkFactor({ width: 3264, height: 2448 }), 3); // 8 MP → 1088
  assert.equal(shrinkFactor({ width: 2000, height: 1000 }, 1000), 2);
});

test("boxDownscaleRgb averages each block and emits RGBA", () => {
  // 4×2 RGB: left half red, right half blue → 2×1 with the blocks' averages
  const rgb = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
  const out = boxDownscaleRgb(rgb, 4, 2, 2);
  assert.deepEqual([out.width, out.height], [2, 1]);
  assert.deepEqual([...out.data], [255, 0, 0, 255, 0, 0, 255, 255]);
});

test("resizeJpegForReport: a big photo comes back smaller and within the edge; a small one is untouched; a non-JPEG is returned as it came", () => {
  const big = photo(2400, 1800, 95);
  const r = resizeJpegForReport(big, { maxEdge: 800, keepUnderBytes: 1 });
  assert.equal(r.resized, true);
  assert.deepEqual([r.width, r.height], [800, 600]);
  assert.ok(r.bytes.length < big.length, "fewer bytes");
  assert.deepEqual(jpegDimensions(r.bytes), { width: 800, height: 600 }, "the output is a JPEG of the new size");
  const small = photo(640, 480);
  const s = resizeJpegForReport(small);
  assert.equal(s.resized, false);
  assert.equal(s.bytes, small);
  assert.deepEqual([s.width, s.height], [640, 480]);
  // within the edge but over the byte limit: re-encoded at the same size
  const fat = resizeJpegForReport(photo(1000, 500, 100), { keepUnderBytes: 10 });
  assert.equal(fat.resized, true);
  assert.deepEqual([fat.width, fat.height], [1000, 500]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const p = resizeJpegForReport(png, { contentType: "image/png" });
  assert.equal(p.resized, false);
  assert.equal(p.bytes, png);
  assert.equal(p.contentType, "image/png");
});

// --- EXIF orientation (2026-11-05): portrait phone photos came out sideways in the PDFs ---

/** RGB of one pixel of a JPEG. */
function pixel(jpg, x, y) {
  const d = jpeg.decode(jpg, { useTArray: true });
  const i = (y * d.width + x) * 4;
  return { r: d.data[i], g: d.data[i + 1], b: d.data[i + 2], width: d.width, height: d.height };
}
const isRed = (p) => p.r > 180 && p.b < 80;
const isBlue = (p) => p.b > 180 && p.r < 80;

test("jpegOrientation reads tag 0x0112 from the APP1 segment, both byte orders, SHORT or LONG; 1 when absent, cut off or not a JPEG", () => {
  const base = markedPhoto();
  assert.equal(jpegOrientation(base), 1, "jpeg-js writes no EXIF");
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal(jpegOrientation(withOrientation(base, o)), o);
  assert.equal(jpegOrientation(withOrientation(base, 6, { littleEndian: true })), 6);
  assert.equal(jpegOrientation(withOrientation(base, 8, { type: 4 })), 8);
  assert.equal(jpegOrientation(withOrientation(base, 6).subarray(0, 30)), 1, "cut off inside the segment");
  assert.equal(jpegOrientation(withOrientation(base, 6).subarray(0, 64 * 1024)), 6, "a 64 KB range read is enough");
  assert.equal(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 1);
});

test("resizeJpegForReport turns an orientation-6 photo upright: width and height swap, the top-left corner lands top-right, no EXIF in the output", () => {
  const src = withOrientation(markedPhoto(), 6);
  const r = resizeJpegForReport(src, { maxEdge: 1600, keepUnderBytes: 1 });
  assert.equal(r.resized, true);
  assert.equal(r.orientation, 6);
  assert.deepEqual([r.width, r.height], [32, 64]);
  assert.deepEqual(jpegDimensions(r.bytes), { width: 32, height: 64 });
  assert.equal(jpegOrientation(r.bytes), 1, "the output carries no orientation tag");
  // 90° clockwise: the source's top-left red block is now the top-RIGHT corner
  assert.ok(isRed(pixel(r.bytes, 28, 3)), "red top-right");
  assert.ok(isBlue(pixel(r.bytes, 3, 3)), "blue top-left");
  assert.ok(isBlue(pixel(r.bytes, 28, 60)), "blue bottom-right");
});

test("orientation 3 (180°) and 8 (90° counter-clockwise), little-endian too", () => {
  const r3 = resizeJpegForReport(withOrientation(markedPhoto(), 3, { littleEndian: true }), { keepUnderBytes: 1 });
  assert.deepEqual([r3.width, r3.height], [64, 32], "180° keeps the shape");
  assert.ok(isRed(pixel(r3.bytes, 60, 28)), "red bottom-right");
  assert.ok(isBlue(pixel(r3.bytes, 3, 3)));
  const r8 = resizeJpegForReport(withOrientation(markedPhoto(), 8), { keepUnderBytes: 1 });
  assert.deepEqual([r8.width, r8.height], [32, 64]);
  assert.ok(isRed(pixel(r8.bytes, 3, 60)), "red bottom-left");
  assert.ok(isBlue(pixel(r8.bytes, 28, 3)));
});

test("orientation 1 is unchanged; a SMALL orientation-6 JPEG (under KEEP_UNDER_BYTES) is still turned, never returned untouched", () => {
  const base = markedPhoto();
  const one = resizeJpegForReport(withOrientation(base, 1));
  assert.equal(one.resized, false, "upright and small: as it came");
  assert.equal(jpegOrientation(one.bytes), 1);
  const src = withOrientation(base, 6);
  assert.ok(src.length < KEEP_UNDER_BYTES);
  const six = resizeJpegForReport(src);
  assert.equal(six.resized, true, "decoded, turned, re-encoded");
  assert.notEqual(six.bytes, src);
  assert.deepEqual(jpegDimensions(six.bytes), { width: 32, height: 64 });
});

test("orientRgb: every orientation maps the 2 × 1 image [A B] where the EXIF spec says", () => {
  const rgb = new Uint8Array([1, 1, 1, 2, 2, 2]); // A at (0,0), B at (1,0)
  const at = (o) => {
    const r = orientRgb(rgb, 2, 1, o);
    return { w: r.width, h: r.height, px: [...r.data].filter((_, i) => i % 3 === 0) };
  };
  assert.deepEqual(at(1), { w: 2, h: 1, px: [1, 2] });
  assert.deepEqual(at(2), { w: 2, h: 1, px: [2, 1] });
  assert.deepEqual(at(3), { w: 2, h: 1, px: [2, 1] });
  assert.deepEqual(at(4), { w: 2, h: 1, px: [1, 2] });
  assert.deepEqual(at(5), { w: 1, h: 2, px: [1, 2] }); // transpose: A top, B below
  assert.deepEqual(at(6), { w: 1, h: 2, px: [1, 2] }); // 90° CW: A top
  assert.deepEqual(at(7), { w: 1, h: 2, px: [2, 1] });
  assert.deepEqual(at(8), { w: 1, h: 2, px: [2, 1] }); // 90° CCW: B top
});


test("cachedCopyNeedsRemake: new copy → kept, nothing read; old copy → re-made only when the original is turned; a failed read keeps it", async () => {
  const { ORIENTATION_FIX_AT, cachedCopyNeedsRemake } = await import("./image-resize.js");
  const turned = withOrientation(markedPhoto(), 6);
  let reads = 0;
  const head = (b) => async () => (reads++, b);
  assert.equal(await cachedCopyNeedsRemake("2026-11-05T21:00:00Z", head(turned)), false);
  assert.equal(await cachedCopyNeedsRemake(ORIENTATION_FIX_AT, head(turned)), false, "at the moment of the fix counts as fixed");
  assert.equal(reads, 0, "a new copy never reads the original");
  assert.equal(await cachedCopyNeedsRemake("2026-11-01T00:00:00Z", head(turned)), true);
  assert.equal(await cachedCopyNeedsRemake(new Date("2026-11-01T00:00:00Z"), head(markedPhoto())), false, "upright original: keep");
  assert.equal(await cachedCopyNeedsRemake(null, head(turned)), true, "unknown date counts as old");
  assert.equal(await cachedCopyNeedsRemake("2026-11-01T00:00:00Z", async () => { throw new Error("s3"); }), false);
});
