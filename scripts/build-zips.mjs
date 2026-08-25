// Rebuild the deployable zip for EVERY Salesforce package folder.
//
//   npm run build-zips              # all packages
//   npm run build-zips -- v2-field-alignments v3-redline-commission-fields
//
// A package folder is any directory under salesforce/ containing a package.xml. Each is
// handed to scripts/zip-package.mjs, which does the actual archiving — forward-slash entry
// names, package.xml at the root, metadata only.
//
// WHY A LOOP EXISTS AT ALL: the failure this prevents is shipping ONE fixed package
// alongside a STALE sibling. The NS markup fix needed v3 and v2-field-alignments to land
// together, and rebuilding them one command at a time is exactly where "I thought I'd
// already rebuilt that one" comes from. Building all of them costs a second and removes
// the question.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const salesforce = path.join(root, "salesforce");

const wanted = process.argv.slice(2);

const packages = fs
  .readdirSync(salesforce, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(salesforce, e.name, "package.xml")))
  .map((e) => e.name)
  .filter((name) => wanted.length === 0 || wanted.includes(name))
  .sort();

if (packages.length === 0) {
  console.error(
    wanted.length
      ? `no package folder matched: ${wanted.join(", ")}`
      : "no package folders found under salesforce/"
  );
  process.exit(1);
}

console.log(`Building ${packages.length} package zip(s)\n`);
let failed = 0;
for (const name of packages) {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(here, "zip-package.mjs"), path.join("salesforce", name)],
      { cwd: root, encoding: "utf8" }
    );
    // Keep the roll-up readable: the per-package detail is one line each, and the full
    // entry table stays available by running zip-package.mjs directly.
    const wrote = out.split("\n").find((l) => l.startsWith("wrote ")) ?? "";
    const stats = out.split("\n").find((l) => l.includes("entries,")) ?? "";
    console.log(`  ✅ ${name.padEnd(32)} ${stats.trim()}`);
    if (!wrote) console.log(out);
  } catch (e) {
    failed++;
    console.log(`  ✗  ${name.padEnd(32)} FAILED`);
    console.log(String(e.stdout ?? "") + String(e.stderr ?? e.message));
  }
}

console.log(
  failed === 0
    ? `\nAll ${packages.length} zip(s) rebuilt from what is on disk right now.\n`
    : `\n${failed} of ${packages.length} package(s) failed.\n`
);
process.exitCode = failed === 0 ? 0 : 1;
