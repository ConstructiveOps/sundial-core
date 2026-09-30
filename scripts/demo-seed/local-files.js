// local-files.js — the run's local folder (migration/demo): read a JSON file, write one
// so that a crash in the middle of a save cannot leave half a file behind.
//
// Kept apart from real-io.js (which pulls in the AWS and Salesforce clients) so the tests
// can exercise the real file code against a temporary folder.
//
// WHY THE RETRY: the id-map is saved after EVERY record — about 900 temp-file renames in a
// full seed. On Windows a rename onto an existing file fails with EPERM / EBUSY / EACCES
// for a moment whenever antivirus or the search indexer has the target open. That is not
// an error worth stopping a seed for: wait a little and try again, and if the file stays
// locked, write it in place (not atomic, but the whole content is in memory and the record
// it describes already exists in Salesforce — a stale id-map is the worse outcome).

import * as fsp from "node:fs/promises";
import { resolve } from "node:path";

export const RENAME_ATTEMPTS = 5;
/** The codes Windows gives when another process holds the file for a moment. */
export const LOCKED_CODES = Object.freeze(["EPERM", "EBUSY", "EACCES"]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} outDir
 * @param {{ fs?: object, sleep?: (ms:number)=>Promise<void>, onFallback?: (name:string, code:string)=>void }} [opts]
 *        fs: mkdir / readFile / writeFile / rename / unlink (node:fs/promises by default; the tests pass a flaky one)
 */
export function localFiles(outDir, opts = {}) {
  const fs = opts.fs ?? fsp;
  const sleep = opts.sleep ?? wait;
  const path = (name) => resolve(outDir, name);
  return {
    outDir,
    path,
    async readJson(name) {
      try {
        return JSON.parse(await fs.readFile(path(name), "utf8"));
      } catch (e) {
        if (e?.code === "ENOENT") return null;
        throw e;
      }
    },
    /**
     * Temp file + rename. A locked target is retried with a short, growing pause; after
     * RENAME_ATTEMPTS the file is overwritten directly. Throws only when the content could
     * not be written at all — the caller must then NOT claim the file is up to date.
     */
    async writeJsonAtomic(name, obj) {
      await fs.mkdir(outDir, { recursive: true });
      const text = JSON.stringify(obj, null, 2) + "\n";
      const tmp = path(`${name}.tmp`);
      const target = path(name);
      await fs.writeFile(tmp, text, "utf8");
      let lastCode = null;
      for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
        try {
          await fs.rename(tmp, target);
          return;
        } catch (e) {
          if (!LOCKED_CODES.includes(e?.code)) throw e;
          lastCode = e.code;
          if (attempt < RENAME_ATTEMPTS) await sleep(40 * attempt); // 40, 80, 120, 160 ms
        }
      }
      // Still locked for a rename. Overwrite in place; if even that fails, the error goes up.
      await fs.writeFile(target, text, "utf8");
      if (opts.onFallback) opts.onFallback(name, lastCode);
      try {
        await fs.unlink(tmp);
      } catch {
        // A leftover .tmp file is harmless (git-ignored, overwritten by the next save).
      }
    },
  };
}
