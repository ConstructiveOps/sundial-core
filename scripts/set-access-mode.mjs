// Set ACCESS_MODEL_MODE across every Lambda that enforces the access model (D-064).
//
//   node scripts/set-access-mode.mjs                 # report the current map for each
//   node scripts/set-access-mode.mjs --set enforce   # read-merge-write, then re-read
//   node scripts/set-access-mode.mjs --set off       # the rollback
//
// ---------------------------------------------------------------------------
// WHY THIS SCRIPT EXISTS
// ---------------------------------------------------------------------------
// The enforcement flag lives on NINE Lambdas, and a function whose flag is missing
// enforces NOTHING while looking perfectly deployed. That failure is silent from every
// angle: the code is there, the tests pass, the deploy said SUCCESS, and the gate simply
// never runs. It was caught once by hand tonight on sundial-sf-update; a second
// occurrence would not have been.
//
// ⚠️ `aws lambda update-function-configuration` REPLACES the whole Variables map. Several
// of these functions carry variables that matter — sundial-budget has S3_BUCKET,
// sundial-aurora-push has six including EMAIL_FROM — and sending only ACCESS_MODEL_MODE
// would delete them. Every write below is read-merge-write, and every one is re-read and
// diffed afterwards, because a dropped variable does not announce itself: losing
// EMAIL_FROM makes design-request notifications silently stop.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REGION = "us-west-1";
const SET = (() => {
  const i = process.argv.indexOf("--set");
  return i === -1 ? null : process.argv[i + 1];
})();

/** Every Lambda that reads ACCESS_MODEL_MODE. Keep in step with the code. */
const FUNCTIONS = [
  "sundial-sf-query",
  "sundial-sf-update",
  "sundial-list-files",
  "sundial-list-related-files",
  "sundial-upload-file",
  "sundial-delete-file",
  "sundial-budget",
  "sundial-acumatica-push",
  "sundial-aurora-push",
];

const VALID = new Set(["off", "shadow", "enforce"]);
if (SET !== null && !VALID.has(SET)) {
  console.error(`--set must be one of: ${[...VALID].join(" | ")}`);
  process.exit(2);
}

function aws(args) {
  return execFileSync("aws", [...args, "--region", REGION, "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readEnv(fn) {
  const raw = aws([
    "lambda",
    "get-function-configuration",
    "--function-name",
    fn,
    "--query",
    "Environment.Variables",
  ]);
  return JSON.parse(raw) || {};
}

let changed = 0;
let failures = 0;

console.log("=".repeat(90));
console.log(`ACCESS_MODEL_MODE across ${FUNCTIONS.length} Lambdas` + (SET ? `  ->  set "${SET}"` : "  (report only)"));
console.log("=".repeat(90));

for (const fn of FUNCTIONS) {
  let before;
  try {
    before = readEnv(fn);
  } catch (e) {
    console.log(`  ${fn.padEnd(30)} ** could not read: ${e.message.split("\n")[0]}`);
    failures++;
    continue;
  }
  const current = before.ACCESS_MODEL_MODE ?? "(unset -> off)";

  if (!SET) {
    console.log(`  ${fn.padEnd(30)} ${current}`);
    continue;
  }

  if (before.ACCESS_MODEL_MODE === SET) {
    console.log(`  ${fn.padEnd(30)} ${current}  (already correct)`);
    continue;
  }

  const merged = { ...before, ACCESS_MODEL_MODE: SET };
  const file = path.join(os.tmpdir(), `sundial-env-${fn}.json`);
  fs.writeFileSync(file, JSON.stringify({ Variables: merged }, null, 2), "utf8");
  try {
    aws([
      "lambda",
      "update-function-configuration",
      "--function-name",
      fn,
      "--environment",
      `file://${file}`,
    ]);
    execFileSync("aws", ["lambda", "wait", "function-updated", "--function-name", fn, "--region", REGION]);
  } finally {
    fs.unlinkSync(file);
  }

  // RE-READ and diff. A dropped variable does not announce itself.
  const after = readEnv(fn);
  const dropped = Object.keys(before).filter((k) => !(k in after));
  const changedOther = Object.keys(before).filter(
    (k) => k !== "ACCESS_MODEL_MODE" && before[k] !== after[k]
  );
  const ok =
    after.ACCESS_MODEL_MODE === SET && dropped.length === 0 && changedOther.length === 0;
  if (!ok) failures++;
  else changed++;

  console.log(
    `  ${fn.padEnd(30)} ${current} -> ${after.ACCESS_MODEL_MODE}` +
      `   (${Object.keys(after).length} var(s) kept)` +
      (ok ? "" : `   ** DROPPED: ${dropped.join(",")} CHANGED: ${changedOther.join(",")} **`)
  );
}

if (SET) {
  console.log("-".repeat(90));
  console.log(
    failures === 0
      ? `${changed} changed, ${FUNCTIONS.length - changed} already correct, 0 failures.`
      : `** ${failures} FAILURE(S) — a Lambda without the flag enforces NOTHING **`
  );
}
process.exit(failures === 0 ? 0 : 1);
