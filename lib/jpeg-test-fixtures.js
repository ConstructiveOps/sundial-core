// lib/jpeg-test-fixtures.js — test-only JPEGs with an EXIF orientation tag spliced in (2026-11-05).
// Used by lib/image-resize.test.js and the estimate Lambda's photo-report PDF test; never bundled.

import jpeg from "jpeg-js";

/** A 64 × 32 JPEG: the top-left 16 × 16 block red, everything else blue. */
export function markedPhoto(quality = 95) {
  const w = 64;
  const h = 32;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const red = x < 16 && y < 16;
      data[i] = red ? 255 : 0;
      data[i + 1] = 0;
      data[i + 2] = red ? 0 : 255;
      data[i + 3] = 255;
    }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, quality).data);
}

/** The same JPEG with an APP1 Exif segment carrying orientation `o`, spliced in after SOI. */
export function withOrientation(jpg, o, { littleEndian = false, type = 3 } = {}) {
  const tiff = Buffer.alloc(26);
  const w16 = (v, p) => (littleEndian ? tiff.writeUInt16LE(v, p) : tiff.writeUInt16BE(v, p));
  const w32 = (v, p) => (littleEndian ? tiff.writeUInt32LE(v, p) : tiff.writeUInt32BE(v, p));
  tiff.write(littleEndian ? "II" : "MM", 0, "latin1");
  w16(42, 2);
  w32(8, 4); // IFD0 right after the header
  w16(1, 8); // one entry
  w16(0x0112, 10);
  w16(type, 12);
  w32(1, 14);
  if (type === 3) w16(o, 18);
  else w32(o, 18);
  w32(0, 22); // no next IFD
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(body.length + 2, 2);
  const b = Buffer.from(jpg);
  return new Uint8Array(Buffer.concat([b.subarray(0, 2), seg, body, b.subarray(2)]));
}

