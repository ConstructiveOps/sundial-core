// lib/photo-thumbs.js — the job page's ~400 px photo copies (2026-10-22).

import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { THUMB_MAX_EDGE, THUMB_PREFIX, backfillThumbs, canThumbInline, isThumbable, makeThumb, thumbKey, thumbPrefix, withThumbUrls } from "./photo-thumbs.js";
import { jpegDimensions } from "./image-resize.js";

export function jpegOf(width, height) {
  const data = new Uint8Array(width * height * 4).fill(128);
  return new Uint8Array(jpeg.encode({ data, width, height }, 90).data);
}

test("keys live under SUNDIAL/_cache/photo-thumbs/{jobId}/, never in the job's own folder; one per photo, stable", () => {
  const k = thumbKey("JOB1", "SUNDIAL/JOB1/photos/C1/a.jpg");
  assert.ok(k.startsWith(`${THUMB_PREFIX}/JOB1/`));
  assert.ok(k.startsWith(thumbPrefix("JOB1")));
  assert.ok(!k.startsWith("SUNDIAL/JOB1/"));
  assert.match(k, /-400\.jpg$/);
  assert.equal(k, thumbKey("JOB1", "SUNDIAL/JOB1/photos/C1/a.jpg"));
  assert.notEqual(k, thumbKey("JOB1", "SUNDIAL/JOB1/photos/C1/b.jpg"));
  assert.equal(isThumbable("x/IMG_1.JPG"), true);
  assert.equal(isThumbable("x/a.jpeg"), true);
  assert.equal(isThumbable("x/a.heic"), false);
  assert.equal(isThumbable("x/a.pdf"), false);
  assert.equal(canThumbInline({ AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "256" }), false);
  assert.equal(canThumbInline({ AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "1024" }), true);
  assert.equal(canThumbInline({}), false);
});

test("makeThumb: a big JPEG → ≤400 px copy written; a small one → copied as-is; not a JPEG → skipped without a read; the original is never written", async () => {
  const store = new Map([["SUNDIAL/J/photos/big.jpg", jpegOf(1600, 1200)], ["SUNDIAL/J/photos/small.jpg", jpegOf(300, 200)]]);
  const puts = [];
  const reads = [];
  const deps = { getObject: async ({ key }) => (reads.push(key), { bytes: store.get(key) }), putObject: async (o) => puts.push(o) };
  const big = await makeThumb(deps, "J", "SUNDIAL/J/photos/big.jpg");
  assert.equal(big.status, "made");
  const dims = jpegDimensions(puts[0].body);
  assert.ok(Math.max(dims.width, dims.height) <= THUMB_MAX_EDGE, JSON.stringify(dims));
  assert.equal(puts[0].contentType, "image/jpeg");
  const small = await makeThumb(deps, "J", "SUNDIAL/J/photos/small.jpg");
  assert.ok(["made", "copied"].includes(small.status));
  assert.equal((await makeThumb(deps, "J", "SUNDIAL/J/photos/doc.heic")).status, "skipped");
  assert.equal(reads.includes("SUNDIAL/J/photos/doc.heic"), false);
  assert.ok(puts.every((p) => p.key.startsWith(THUMB_PREFIX)), "only thumbs are written");
  assert.equal((await makeThumb({ getObject: async () => { throw new Error("gone"); }, putObject: async () => {} }, "J", "a.jpg")).status, "failed");
});

test("withThumbUrls + backfillThumbs: present thumbs get a URL, missing ones null; the backfill skips done / non-JPEG and stops at the budget", async () => {
  const photos = [{ key: "SUNDIAL/J/photos/a.jpg" }, { key: "SUNDIAL/J/photos/b.jpg" }, { key: "SUNDIAL/J/photos/c.png" }];
  const have = new Set([thumbKey("J", "SUNDIAL/J/photos/a.jpg")]);
  const listed = withThumbUrls(photos, "J", have);
  assert.match(listed[0].thumbUrl, /^https:\/\/.*\/SUNDIAL\/_cache\/photo-thumbs\/J\//);
  assert.equal(listed[1].thumbUrl, null);
  const deps = { getObject: async () => ({ bytes: jpegOf(800, 600) }), putObject: async () => {} };
  const t = await backfillThumbs(deps, "J", photos, have);
  assert.deepEqual(t, { made: 1, copied: 0, skipped: 1, failed: 0, already: 1, remaining: 0 });
  let clock = 0;
  const many = Array.from({ length: 5 }, (_, i) => ({ key: `SUNDIAL/J/photos/${i}.jpg` }));
  const partial = await backfillThumbs(deps, "J", many, new Set(), { budgetMs: 25, now: () => (clock += 10) });
  assert.ok(partial.remaining > 0 && partial.made + partial.remaining === 5, JSON.stringify(partial));
});
