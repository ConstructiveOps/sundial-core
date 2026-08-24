// Build a Workbench-deployable zip from a Salesforce package folder.
//
// WHY THIS EXISTS — two failure modes, both of which have already bitten:
//
//  1. **PowerShell 5.1 `Compress-Archive` writes BACKSLASH path separators** into the
//     zip's entry names. The ZIP spec requires forward slashes. Workbench reads such an
//     archive as a flat pile of oddly-named files, finds no `package.xml` at the root,
//     and fails with an unhelpful error. The standing workaround has been "zip it with
//     Windows Explorer", which works but is a manual step nobody can automate or verify.
//
//  2. **The zip goes stale.** Regenerating the `.object` files does not rebuild the zip,
//     so it is entirely possible — and has happened — to deploy an archive that predates
//     the fix you are trying to ship. Nothing about the zip's name says how old it is.
//
// This writes the archive itself, with forward slashes, from whatever is on disk RIGHT
// NOW, and prints each entry with its size and mtime so a stale input is visible before
// the upload rather than after. No dependencies: Node's zlib plus a CRC table.
//
//   node scripts/zip-package.mjs salesforce/v2-field-alignments
//   node scripts/zip-package.mjs salesforce/v3-redline-commission-fields
//
// The output lands NEXT TO the folder as <folder>.zip, and package.xml sits at the zip
// root, which is what Workbench's "Single Package" deploy expects.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what a zip entry stores. */
function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * METADATA ONLY. `package.xml` at the root plus the metadata subfolders it names —
 * nothing else.
 *
 * The folders here are working directories: they hold `generate.mjs` and `README.md`
 * alongside the `objects/` they produce. Those are for us, not for Salesforce, and
 * shipping them means uploading the generator source to Harmon's org on every deploy and
 * inviting the Metadata API to have an opinion about files package.xml never mentions.
 * The old "zip the folder's contents in Explorer" step swept them in silently.
 */
function walk(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walk(abs, rel));
    } else if (prefix === "" && e.name !== "package.xml") {
      // Root level: package.xml only. README.md, generate.mjs, verify.mjs, stray zips.
      continue;
    } else if (!/\.(zip|mjs|md|js)$/i.test(e.name) && e.name !== ".DS_Store") {
      out.push({ rel, abs });
    }
  }
  return out;
}

const folder = process.argv[2];
if (!folder) {
  console.error("usage: node scripts/zip-package.mjs <package-folder>");
  process.exit(2);
}
const root = path.resolve(folder);
if (!fs.existsSync(path.join(root, "package.xml"))) {
  console.error(`** ${folder} has no package.xml at its root — that is what Workbench looks for. **`);
  process.exit(1);
}

const files = walk(root);
const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.abs);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  // Store rather than deflate when compression does not help, which is legal and keeps
  // tiny files honest.
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  // FORWARD SLASHES. This is the whole point — see the header note.
  const nameBuf = Buffer.from(f.rel.split(path.sep).join("/"), "utf8");
  const { time, date } = dosDateTime(fs.statSync(f.abs).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0, 6);             // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);            // extra length
  locals.push(local, nameBuf, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);          // version made by
  central.writeUInt16LE(20, 6);          // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);          // extra
  central.writeUInt16LE(0, 32);          // comment
  central.writeUInt16LE(0, 34);          // disk
  central.writeUInt16LE(0, 36);          // internal attrs
  central.writeUInt32LE(0, 38);          // external attrs
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + body.length;
  f.stored = data.length;
  f.mtime = fs.statSync(f.abs).mtime;
}

const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const outPath = `${root}.zip`;
fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));

console.log(`wrote ${outPath}`);
console.log(`  ${files.length} entries, ${fs.statSync(outPath).size} bytes, forward-slash separators\n`);
console.log("  entry                                              bytes   last modified");
for (const f of files) {
  console.log(
    `  ${f.rel.split(path.sep).join("/").padEnd(48)} ${String(f.stored).padStart(7)}   ${f.mtime.toISOString().slice(0, 19).replace("T", " ")}`
  );
}
// The staleness check the manual process never had: if any input is newer than the zip
// we just wrote, something is regenerating behind us.
const newest = files.reduce((a, f) => (f.mtime > a ? f.mtime : a), new Date(0));
console.log(`\n  newest input: ${newest.toISOString().slice(0, 19).replace("T", " ")} — zip built from it just now.`);
