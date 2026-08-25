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

/**
 * MANIFEST vs CONTENTS — refuse to build a zip whose package.xml and .object files
 * disagree about which fields are being deployed.
 *
 * WHY THIS EXISTS. On 2026-08-24 this builder shipped exactly that inconsistency and
 * Workbench rejected the deploy with five "Not in package.xml" errors. The cause was a
 * STALE OBJECT FILE: the v2-field-alignments generator re-reads the live org and only
 * writes an .object for objects that still have pending changes. Once the NS markup fix
 * deployed, Customer had nothing left to change, so the generator stopped writing
 * Customer — but never DELETED the previous run's file. package.xml was rewritten to two
 * Solar members; objects/Sundial_Customer__c.object still listed five markup fields.
 *
 * The builder printed both files' mtimes, six minutes apart, and validated nothing. A
 * report that a human has to read carefully is not a check. This is the check.
 *
 * Scope: CustomField members only. Other metadata types (PermissionSet, Flow) have no
 * file in objects/ to compare against, so they are counted and reported but not verified
 * here — claiming otherwise would be the same false assurance in a new place.
 */
function validateManifest(root, files) {
  const pkgPath = path.join(root, "package.xml");
  const pkg = fs.readFileSync(pkgPath, "utf8");

  // Members declared per metadata type.
  const declared = new Map();
  for (const m of pkg.matchAll(/<types>([\s\S]*?)<\/types>/g)) {
    const body = m[1];
    const typeName = /<name>([^<]+)<\/name>/.exec(body)?.[1] ?? "(unnamed)";
    const members = [...body.matchAll(/<members>([^<]+)<\/members>/g)].map((x) => x[1].trim());
    declared.set(typeName, new Set(members));
  }

  const declaredFields = declared.get("CustomField") ?? new Set();

  // Fields actually present in the object files being zipped.
  const present = new Set();
  const perFile = [];
  for (const f of files) {
    if (!/^objects\/.+\.object$/.test(f.rel.split(path.sep).join("/"))) continue;
    const objName = path.basename(f.rel, ".object");
    const xml = fs.readFileSync(f.abs, "utf8");
    const names = [...xml.matchAll(/<fields>[\s\S]*?<fullName>([^<]+)<\/fullName>/g)].map((x) => x[1]);
    for (const n of names) present.add(`${objName}.${n}`);
    perFile.push({ objName, count: names.length });
  }

  const missingFromManifest = [...present].filter((x) => !declaredFields.has(x)).sort();
  const missingFromContents = [...declaredFields].filter((x) => !present.has(x)).sort();

  const otherTypes = [...declared.entries()].filter(([t]) => t !== "CustomField");

  return { declaredFields, present, perFile, missingFromManifest, missingFromContents, otherTypes };
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

// ---------------------------------------------------------------------------
// VALIDATE BEFORE WRITING. A zip that cannot deploy should never reach the disk, because
// a bad zip sitting next to a good one is exactly how the wrong file gets uploaded.
// ---------------------------------------------------------------------------
const v = validateManifest(root, files);
if (v.missingFromManifest.length > 0 || v.missingFromContents.length > 0) {
  console.error(`\n** ${folder}: package.xml and the .object files DISAGREE — refusing to build. **\n`);
  console.error(
    `  package.xml declares ${v.declaredFields.size} CustomField member(s); ` +
      `the object files contain ${v.present.size} field(s).`
  );
  for (const f of v.perFile) console.error(`     objects/${f.objName}.object — ${f.count} field(s)`);

  if (v.missingFromManifest.length) {
    console.error(
      `\n  IN AN .object FILE BUT NOT IN package.xml (${v.missingFromManifest.length}) —` +
        ` Workbench rejects these as "Not in package.xml":`
    );
    for (const x of v.missingFromManifest) console.error(`     ${x}`);
    console.error(
      "\n  Usually a STALE object file: the generator stopped writing that object because it\n" +
        "  had no pending changes, but the previous run's file is still on disk. Re-run the\n" +
        "  package's generate.mjs (it now removes them), or delete the file by hand."
    );
  }
  if (v.missingFromContents.length) {
    console.error(
      `\n  IN package.xml BUT NOT IN ANY .object FILE (${v.missingFromContents.length}) —` +
        " the deploy would silently skip these:"
    );
    for (const x of v.missingFromContents) console.error(`     ${x}`);
    console.error("\n  Usually a manifest written by hand, or a generator run that failed part way.");
  }
  console.error("");
  process.exit(1);
}

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
console.log(`  ${files.length} entries, ${fs.statSync(outPath).size} bytes, forward-slash separators`);
console.log(
  `  manifest ✅ ${v.declaredFields.size} CustomField member(s) match ${v.present.size} field(s) across ` +
    `${v.perFile.length} object file(s)` +
    (v.otherTypes.length
      ? `; ${v.otherTypes.map(([t, m]) => `${m.size} ${t}`).join(", ")} declared (not file-verifiable)`
      : "")
);
console.log("");
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
