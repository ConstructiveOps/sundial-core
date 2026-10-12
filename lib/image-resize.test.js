// lib/image-resize.js — the report PDF's photos, shrunk for the page (2026-10-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { boxDownscaleRgb, isJpeg, jpegDimensions, resizeJpegForReport, shrinkFactor } from "./image-resize.js";

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
