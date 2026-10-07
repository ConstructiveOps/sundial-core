// lambdas/sundial-hcp-media — copy Housecall Pro job photos / documents into Sundial's
// S3 (2026-10-05, the HCP migration's "attachments gap"; docs/migration.md).
//
// A plain invoke (no API Gateway, no identity): `scripts/hcp-media-pull.mjs` on Tim's
// PowerShell sends batches of jobs and resumes from what each run reports. The bytes
// move S3 → S3 inside AWS; nothing passes through a PC. Event:
//
//   { "tenant": "harmon",
//     "jobs": [{ "hcpJobId": "job_…", "hcpCustomerId": "cus_…", "sfJobId": "a1J…" }, …],
//     "dryRun": false }
//
// Response: { results: [ per job: { hcpJobId, sfJobId, listed, copied, exists, skipped,
// failed, bytes, files: [{ id, key, name, size, status, error? }] } ], done, remaining,
// error? } — `remaining` is what the clock did not reach (a run stops itself ~90 s before
// the Lambda's timeout so nothing is cut off mid-file); `error: "SESSION_EXPIRED"` means
// the cookie in Secrets Manager `sundial/hcp` → `webCookie` needs refreshing.
//
// Credentials: the HCP login cookie from `sundial/hcp` (webCookie), the Supabase service
// role from `sundial/supabase/service-role`, S3 through the function's role. The cookie is
// never logged. Tenant: the event's slug → Sundial_Tenant__c (Client__c on the metadata
// rows). Nothing here reads or writes Salesforce beyond that one lookup.
//
// Console setup (Tim, once): Lambda → Create function `sundial-hcp-media`, Node 22,
// same role as sundial-service-board (S3 + Secrets Manager), memory 2048 MB, timeout
// 15 min. Then `.\deploy.ps1 sundial-hcp-media`.

import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSecret } from "../../lib/secrets.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { sfQuery, soqlEscapeString } from "../../lib/salesforce.js";
import { S3_BUCKET, S3_REGION } from "../../lib/file-access.js";
import { copyJobsMedia, createHcpWebClient, HCP_WEB_COOKIE_KEY } from "../../lib/hcp-media.js";
import { HCP_SECRET } from "../../lib/hcp-api.js";

/** Stop taking new jobs this far before the Lambda's timeout. */
const SAFETY_MS = 90 * 1000;

let s3Client;
const s3 = () => (s3Client ??= new S3Client({ region: S3_REGION }));

export async function headObject(key) {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return { size: r.ContentLength ?? null };
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null;
    throw e;
  }
}
export async function putObject({ key, body, contentType, size }) {
  await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType, ContentLength: size }));
}

const tenantIdCache = new Map();
async function tenantIdFor(slug) {
  if (tenantIdCache.has(slug)) return tenantIdCache.get(slug);
  const rows = await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`);
  const id = rows?.[0]?.Id ?? null;
  if (id) tenantIdCache.set(slug, id);
  return id;
}

/** The handler, with its I/O injectable for the test. */
export function createHandler(deps = {}) {
  const d = { getSecret, getSupabaseClient, tenantIdFor, headObject, putObject, fetchImpl: (u) => fetch(u), now: () => Date.now(), ...deps };
  return async (event, context) => {
    const slug = typeof event?.tenant === "string" ? event.tenant.trim() : "";
    const jobs = Array.isArray(event?.jobs) ? event.jobs.filter((j) => j && typeof j.hcpJobId === "string" && typeof j.hcpCustomerId === "string" && typeof j.sfJobId === "string") : [];
    if (!slug) return { ok: false, error: "TENANT_REQUIRED" };
    if (!jobs.length) return { ok: true, results: [], done: 0, remaining: [] };
    const tenantId = await d.tenantIdFor(slug);
    if (!tenantId) return { ok: false, error: "TENANT_UNKNOWN" };
    const secret = await d.getSecret(HCP_SECRET);
    const cookie = secret?.[HCP_WEB_COOKIE_KEY];
    if (!cookie) return { ok: false, error: "COOKIE_MISSING", message: `Secrets Manager ${HCP_SECRET} has no ${HCP_WEB_COOKIE_KEY}` };
    const client = createHcpWebClient({ cookie, fetchImpl: d.fetchWeb ?? ((u, i) => fetch(u, i)), log: (m) => console.log("hcp-media:", m) });
    let supabase = null;
    try {
      supabase = event?.dryRun ? null : await d.getSupabaseClient();
    } catch (e) {
      console.error("hcp-media: no Supabase client — files will copy without Files-tab rows:", e?.message || e);
    }
    const remainingMs = typeof context?.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : 14 * 60 * 1000;
    const deadlineMs = d.now() + Math.max(10_000, remainingMs - SAFETY_MS);
    const out = await copyJobsMedia(jobs, {
      tenantId,
      dryRun: event?.dryRun === true,
      deadlineMs,
      now: d.now,
      deps: { client, headObject: d.headObject, putObject: d.putObject, fetchImpl: d.fetchImpl, supabase, log: (m) => console.log("hcp-media:", m) },
    });
    const totals = out.results.reduce((t, r) => ({ listed: t.listed + r.listed, copied: t.copied + r.copied, exists: t.exists + r.exists, failed: t.failed + r.failed, bytes: t.bytes + r.bytes }), { listed: 0, copied: 0, exists: 0, failed: 0, bytes: 0 });
    console.log(`hcp-media: ${out.done}/${jobs.length} jobs, ${JSON.stringify(totals)}, requests ${client.stats.requests}${out.error ? `, ${out.error}` : ""}`);
    return { ok: !out.error, ...out, totals };
  };
}

export const handler = createHandler();
