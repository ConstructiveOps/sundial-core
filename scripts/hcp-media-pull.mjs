// scripts/hcp-media-pull.mjs — move Housecall Pro job photos / documents into Sundial
// (2026-10-05; docs/migration.md → "The attachments gap").
//
// The work is done by the sundial-hcp-media Lambda (bytes go S3 → S3 inside AWS); this
// script decides WHAT to send it, keeps the ledger, and resumes. It can also do the work
// here (`--via local`), slower, for a handful of jobs or when the Lambda is not up.
//
//   node scripts/hcp-media-pull.mjs --tenant harmon                       # DRY RUN: list + plan, copy nothing
//   node scripts/hcp-media-pull.mjs --tenant harmon --apply --limit 3     # a canary: three jobs
//   node scripts/hcp-media-pull.mjs --tenant harmon --apply               # everything (resumable — run again after a stop)
//   options: --via lambda|local (default lambda)  --batch 25  --only job_x,job_y  --retry-failed  --in migration/hcp
//
// Needs: the pull in migration\hcp\raw\ (jobs.json — which customer each job belongs to),
// the import's migration\hcp\import\id-map.json (HCP job id → Salesforce job id; a job the
// import never created is listed and skipped), AWS credentials (Tim's PowerShell), and the
// HCP login cookie in Secrets Manager `sundial/hcp` → `webCookie` (read by the Lambda —
// this script never sees it in lambda mode).
//
// The ledger: migration\hcp\media\ledger.jsonl — one line per job per run ({ hcpJobId,
// sfJobId, listed, copied, exists, failed, files… }). A job whose last line has no failed
// files is done and skipped next time; `--retry-failed` re-sends jobs with failures.
// SUMMARY.txt at the end. Nothing here writes HCP; nothing writes Salesforce.
//
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a stop must be seen.

import { promises as fs } from "node:fs";
import path from "node:path";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const TENANT = opt("--tenant");
const APPLY = flag("--apply");
const VIA = opt("--via", "lambda");
const BATCH = Math.max(1, Number(opt("--batch", "25")) || 25);
const LIMIT = Number(opt("--limit", "0")) || 0;
const ONLY = (opt("--only", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
const RETRY_FAILED = flag("--retry-failed");
const IN = path.resolve(opt("--in", path.join("migration", "hcp")));
const MEDIA = path.join(IN, "media");
const LEDGER = path.join(MEDIA, "ledger.jsonl");
const FUNCTION_NAME = "sundial-hcp-media";
const REGION = process.env.AWS_REGION || "us-west-1";
if (!TENANT || !["lambda", "local"].includes(VIA)) {
  console.error("usage: node scripts/hcp-media-pull.mjs --tenant <slug> [--apply] [--via lambda|local] [--batch 25] [--limit N] [--only job_a,job_b] [--retry-failed]");
  process.exit(2);
}
const s = (v) => (v == null ? "" : String(v).trim());
const mb = (b) => (b / 1048576).toFixed(1);
const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

console.log("=".repeat(80));
console.log(`HCP MEDIA → SUNDIAL S3 — tenant ${TENANT} ${APPLY ? `(APPLY via ${VIA})` : "(dry run)"}`);
console.log("=".repeat(80));

// ---------------------------------------------------------------- the work list
const jobsHcp = await readJson(path.join(IN, "raw", "jobs.json"), []);
const idMap = await readJson(path.join(IN, "import", "id-map.json"), null);
if (!jobsHcp.length || !idMap?.jobs) {
  console.error(`Need ${path.join(IN, "raw", "jobs.json")} (scripts/hcp-pull.mjs) and ${path.join(IN, "import", "id-map.json")} (scripts/hcp-import.mjs --apply).`);
  process.exit(2);
}
await fs.mkdir(MEDIA, { recursive: true });
const ledger = new Map(); // hcpJobId → its last ledger line
try {
  for (const line of (await fs.readFile(LEDGER, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.hcpJobId) ledger.set(e.hcpJobId, e);
    } catch {}
  }
} catch {}

const all = [];
let noSf = 0;
for (const j of jobsHcp) {
  const hcpJobId = s(j.id);
  const hcpCustomerId = s(j.customer?.id);
  const sfJobId = idMap.jobs[hcpJobId];
  if (!hcpJobId || !hcpCustomerId) continue;
  if (!sfJobId) {
    noSf++;
    continue;
  }
  if (ONLY.length && !ONLY.includes(hcpJobId)) continue;
  const last = ledger.get(hcpJobId);
  if (last && !last.error && last.failed === 0 && !last.dryRun) continue; // done
  if (last && last.failed > 0 && !RETRY_FAILED && !ONLY.length) continue; // left for --retry-failed
  all.push({ hcpJobId, hcpCustomerId, sfJobId, hcpNumber: s(j.invoice_number) });
}
const work = LIMIT ? all.slice(0, LIMIT) : all;
const doneBefore = [...ledger.values()].filter((e) => !e.error && e.failed === 0 && !e.dryRun).length;
const failedBefore = [...ledger.values()].filter((e) => e.failed > 0).length;
console.log(`  ${jobsHcp.length} HCP jobs; ${noSf} not in Sundial (never imported) — skipped; ${doneBefore} done in an earlier run; ${failedBefore} with failures${failedBefore && !RETRY_FAILED ? " (add --retry-failed)" : ""}`);
console.log(`  ${work.length} job(s) to ${APPLY ? "copy" : "plan"}${LIMIT ? ` (--limit ${LIMIT})` : ""}\n`);
if (!work.length) {
  console.log("  nothing to do.\n");
  process.exit(0);
}

// ---------------------------------------------------------------- the two engines
async function runLambda(jobs, dryRun) {
  const lambda = new LambdaClient({ region: REGION });
  const res = await lambda.send(new InvokeCommand({ FunctionName: FUNCTION_NAME, Payload: Buffer.from(JSON.stringify({ tenant: TENANT, jobs, dryRun })) }));
  const text = Buffer.from(res.Payload ?? []).toString("utf8");
  if (res.FunctionError) throw new Error(`Lambda error: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}
let localRun = null;
async function runLocal(jobs, dryRun) {
  if (!localRun) {
    const [{ getSecret }, { getSupabaseClient }, { sfQuery, soqlEscapeString }, { createHcpWebClient, copyJobsMedia, HCP_WEB_COOKIE_KEY }, { HCP_SECRET }, lambdaIndex] = await Promise.all([
      import("../lib/secrets.js"),
      import("../lib/supabase.js"),
      import("../lib/salesforce.js"),
      import("../lib/hcp-media.js"),
      import("../lib/hcp-api.js"),
      import("../lambdas/sundial-hcp-media/index.js"),
    ]);
    const tenantRows = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
    const tenantId = tenantRows?.[0]?.Id;
    if (!tenantId) throw new Error(`No Sundial_Tenant__c named "${TENANT}"`);
    const secret = await getSecret(HCP_SECRET);
    if (!secret?.[HCP_WEB_COOKIE_KEY]) throw new Error(`Secrets Manager ${HCP_SECRET} has no ${HCP_WEB_COOKIE_KEY}`);
    const client = createHcpWebClient({ cookie: secret[HCP_WEB_COOKIE_KEY], log: (m) => console.log("  ", m) });
    const supabase = dryRun ? null : await getSupabaseClient();
    localRun = (batch, dry) => copyJobsMedia(batch, { tenantId, dryRun: dry, deps: { client, headObject: lambdaIndex.headObject, putObject: lambdaIndex.putObject, supabase, log: (m) => console.log("  ", m) } });
  }
  const out = await localRun(jobs, dryRun);
  return { ok: !out.error, ...out };
}
const engine = VIA === "lambda" ? runLambda : runLocal;

// ---------------------------------------------------------------- go
const totals = { jobs: 0, listed: 0, copied: 0, exists: 0, skipped: 0, failed: 0, bytes: 0, jobsFailed: 0 };
const startedAt = Date.now();
let queue = work.slice();
let batchNo = 0;
while (queue.length) {
  const batch = queue.slice(0, BATCH);
  batchNo++;
  let res;
  try {
    res = await engine(batch, !APPLY);
  } catch (e) {
    console.error(`\n  ** batch ${batchNo} failed: ${e?.message || e} **\n     Re-run the script: the ledger has what finished.\n`);
    process.exitCode = 1;
    break;
  }
  const lines = [];
  for (const r of res.results || []) {
    const hcpNumber = batch.find((b) => b.hcpJobId === r.hcpJobId)?.hcpNumber ?? "";
    lines.push(JSON.stringify({ at: new Date().toISOString(), dryRun: !APPLY, hcpNumber, ...r }));
    totals.jobs++;
    totals.listed += r.listed;
    totals.copied += r.copied;
    totals.exists += r.exists ?? 0;
    totals.skipped += r.skipped ?? 0;
    totals.failed += r.failed;
    totals.bytes += r.bytes;
    if (r.error) totals.jobsFailed++;
  }
  if (APPLY && lines.length) await fs.appendFile(LEDGER, lines.join("\n") + "\n");
  const did = res.done ?? batch.length;
  queue = [...(res.remaining || []).map((r) => batch.find((b) => b.hcpJobId === r.hcpJobId) ?? r), ...queue.slice(batch.length)];
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  process.stdout.write(`  batch ${batchNo}: ${did}/${batch.length} jobs · total ${totals.jobs}/${work.length} jobs, ${totals.listed} files, ${APPLY ? `${totals.copied} copied (${mb(totals.bytes)} MB), ${totals.exists} already there, ` : ""}${totals.failed} failed · ${elapsed}s\n`);
  if (res.error === "SESSION_EXPIRED") {
    console.error(`\n  ** ${res.message || "The HCP login cookie has expired."} **\n     Copy a fresh cookie into Secrets Manager sundial/hcp → webCookie (see docs/migration.md), then re-run — it resumes.\n`);
    process.exitCode = 1;
    break;
  }
  if (res.ok === false && res.error) {
    console.error(`\n  ** ${res.error}${res.message ? `: ${res.message}` : ""} **\n`);
    process.exitCode = 1;
    break;
  }
}

// ---------------------------------------------------------------- summary
const failedFiles = [];
if (APPLY) {
  try {
    for (const line of (await fs.readFile(LEDGER, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      for (const f of e.files || []) if (f.status === "failed") failedFiles.push(`${e.hcpNumber || e.hcpJobId}\t${f.key}\t${f.error}`);
    }
  } catch {}
}
const summary = [
  `HCP media → Sundial S3 — ${new Date().toISOString()} — tenant ${TENANT} — ${APPLY ? `applied via ${VIA}` : "dry run"}`,
  `jobs this run ${totals.jobs} (of ${work.length} planned); files listed ${totals.listed}; copied ${totals.copied} (${mb(totals.bytes)} MB); already there ${totals.exists}; too large ${totals.skipped}; failed ${totals.failed}; jobs that could not be listed ${totals.jobsFailed}`,
  `never imported into Sundial (skipped) ${noSf}`,
  failedFiles.length ? `\nFAILED FILES (every run so far; re-send with --retry-failed):\n${failedFiles.join("\n")}` : "",
].filter(Boolean).join("\n");
await fs.writeFile(path.join(MEDIA, "SUMMARY.txt"), summary + "\n");
console.log("\n" + summary);
console.log(`\n  ledger: ${LEDGER}\n  ${APPLY ? "The job pages' Photos (group \"Housecall Pro\") and Files cards show them now — no cache sync needed." : "DRY RUN — nothing copied. Re-run with --apply --limit 3 first, then --apply."}\n`);
