// lib/cache-touch.js — the orientation repair's "touch" of an upright photo's old report copy (2026-11-05).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CopyObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { predatesOrientationFix, touchObject } from "./cache-touch.js";
import { ORIENTATION_FIX_AT } from "./image-resize.js";

test("predatesOrientationFix: before the fix (or undated) → true; at or after it → false", () => {
  assert.equal(predatesOrientationFix("2026-11-01T00:00:00Z"), true);
  assert.equal(predatesOrientationFix(null), true);
  assert.equal(predatesOrientationFix(ORIENTATION_FIX_AT), false);
  assert.equal(predatesOrientationFix(new Date("2026-11-06T00:00:00Z")), false);
});

test("touchObject copies the object onto itself with its OWN metadata and headers (REPLACE), so only LastModified changes", async () => {
  const sent = [];
  const s3 = {
    send: async (cmd) => {
      sent.push(cmd);
      if (cmd instanceof HeadObjectCommand) return { ContentType: "image/jpeg", Metadata: { "sundial-orientation": "upright" }, CacheControl: "max-age=60" };
      return {};
    },
  };
  const key = "SUNDIAL/_cache/report-images/a1cJOB/0123abcd-1600.jpg";
  await touchObject(s3, "sfsolproj", key);
  assert.equal(sent.length, 2);
  assert.ok(sent[0] instanceof HeadObjectCommand);
  assert.ok(sent[1] instanceof CopyObjectCommand);
  assert.deepEqual(sent[1].input, {
    Bucket: "sfsolproj",
    Key: key,
    CopySource: `sfsolproj/${key}`,
    MetadataDirective: "REPLACE",
    Metadata: { "sundial-orientation": "upright" },
    ContentType: "image/jpeg",
    CacheControl: "max-age=60",
  });
});

test("touchObject keeps an object with no metadata as it was, and never touches outside SUNDIAL/_cache/", async () => {
  const sent = [];
  const s3 = { send: async (cmd) => (sent.push(cmd), cmd instanceof HeadObjectCommand ? { ContentType: "image/png" } : {}) };
  const input = await touchObject(s3, "b", "SUNDIAL/_cache/report-images/J/x.jpg");
  assert.deepEqual([input.Metadata, input.ContentType], [{}, "image/png"]);
  await assert.rejects(touchObject(s3, "b", "SUNDIAL/J/photos/p.jpg"), /outside the cache/);
  assert.equal(sent.length, 2, "nothing sent for the refused key");
});
