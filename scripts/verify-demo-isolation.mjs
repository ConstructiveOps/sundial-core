// Is the DEMO tenant (conops-demo) isolated from the primary tenant (harmon)?
//
// Run it BEFORE the cache sync that pulls the seeded records into the portal's lists, and
// again after it:
//
//   node scripts/verify-demo-isolation.mjs                 # before the sync
//   node scripts/verify-demo-isolation.mjs --after-sync    # after the sync
//   node scripts/verify-demo-isolation.mjs --quick         # 5 records per object in the API section
//   node scripts/verify-demo-isolation.mjs --skip-api      # Salesforce + Supabase only
//   node scripts/verify-demo-isolation.mjs --json          # one JSON report on stdout
//
// STRICTLY READ-ONLY. Salesforce: SELECT and describe (this file imports `sfQuery` and
// `describeObject` and no write function). Supabase: select. The portal API: GET.
// Secrets Manager: get. It writes no file. The only POST is the Supabase sign-in that
// scripts/portal-login.mjs already does — what the portal's login page does.
//
// WHAT IT CHECKS (each prints one PASS / FAIL / INFO / SKIP / ERROR line):
//   A  Salesforce    every id in migration/demo/id-map.json exists and carries the demo tenant;
//                    nothing else is in the tenant unaccounted for; no tenant-less record since
//                    the seed; no lookup crosses the tenant line in either direction.
//   B  Supabase      no cache row for a demo record under another tenant; notes, activity,
//                    texts, notifications, files and profiles all on the right side.
//   C  the portal    signed in as a Harmon ZZ TEST user (never a live user): every demo record
//                    is refused, and searches, lists and the dispatch board hold none. Signed in
//                    as the demo user: Harmon's ZZ PORTAL TEST records (never a live customer)
//                    are refused; with --after-sync its lists hold demo records only.
//
// Exit code 1 if any check FAILED or could not be completed (ERROR); 0 otherwise.
// ⚠️ Do not pipe a real run through `head` / `Select-Object -First`: the exit status is
// lost and the verdict is at the end.
//
// The checks live in scripts/demo-seed/verify-isolation.js and are tested offline against a
// fake org with injected faults:
//   node --test scripts/demo-seed/verify-isolation.test.js

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sfQuery, describeObject } from "../lib/salesforce.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { getSecret } from "../lib/secrets.js";
import { loginAs, loginAsTestUser, loadTestPasswords, resolveSupabasePublic } from "./portal-login.mjs";
import { EMAIL as testUserEmail } from "./seed-access-test-fixtures.mjs";
import { verify, parseVerifyArgs, HELP, API_BASE_DEFAULT, TEST_USERS_SECRET } from "./demo-seed/verify-isolation.js";
import { OUT_DIR_PARTS } from "./demo-seed/policy.js";

export { verify };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ID_MAP = resolve(REPO_ROOT, ...OUT_DIR_PARTS, "id-map.json");

/** The real outside world, read-only. */
export function createRealIo({ idMapPath = DEFAULT_ID_MAP, log } = {}) {
  return {
    sfQuery,
    describeObject,
    getSupabase: () => getSupabaseClient(),
    // The ZZ TEST passwords go through the same helper every access script uses.
    getSecret: (name) => (name === TEST_USERS_SECRET ? loadTestPasswords() : getSecret(name)),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(45000) }),
    loginAs,
    loginAsTestUser,
    resolveSupabasePublic,
    /** The id-map, or null when the file is not there. It is only ever read. */
    readIdMap: async () => {
      let text;
      try {
        text = await readFile(idMapPath, "utf8");
      } catch (e) {
        if (e?.code === "ENOENT") return null;
        throw new Error(`${idMapPath}: ${e?.code || "could not be read"}`);
      }
      return JSON.parse(text);
    },
    now: () => new Date(),
    log,
  };
}

async function main(argv) {
  const args = parseVerifyArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.problems.length) {
    for (const p of args.problems) console.error(`error: ${p}`);
    console.error(HELP);
    return 2;
  }
  const io = createRealIo({
    idMapPath: args.idMapPath ? resolve(process.cwd(), args.idMapPath) : DEFAULT_ID_MAP,
    // With --json the lines are kept out of stdout, so stdout is the JSON report and nothing else.
    log: args.json ? () => {} : (line) => console.log(line),
  });
  const report = await verify(io, {
    afterSync: args.afterSync,
    quick: args.quick,
    skipApi: args.skipApi,
    apiBase: process.env.API_BASE_URL || API_BASE_DEFAULT,
    testUserEmail,
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  return report.exitCode;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // Never print a response body here — a Salesforce error body can carry record data.
      console.error(`\nFAILED: ${err?.message || err}\n`);
      process.exitCode = 1;
    });
}
