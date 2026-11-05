// scripts/backfill-job-report-files.mjs — register a sundial_file_metadata row for every sent
// job-report PDF that has none (2026-11-05).
//
//   node scripts/backfill-job-report-files.mjs            # dry run: count and list, write nothing
//   node scripts/backfill-job-report-files.mjs --apply    # register the missing rows
//
// WHY: until 2026-11-05 report.js registered its PDF with the wrong key names, no tenant and an
// un-awaited Supabase client, so every send's metadata insert failed (the PDFs are in S3; the
// rows never landed). This puts the rows back.
//
// WHAT IT READS: the jobs that ever sent a report — Salesforce jobs with Report_Sent_Count__c > 0
// or Report_PDF_S3_Key__c set, plus any job a `job_report_sent` activity event names — then lists
// SUNDIAL/{jobId}/job-report-{n}.pdf in sfsolproj for each. A key that already has a metadata row
// (soft-deleted ones included — a user who deleted the file meant it) is skipped.
//
// WHAT IT WRITES (--apply only): one row per missing PDF through registerFileMetadata (the one
// write path): category "Job Report", tenant = the job's Client__c, object Sundial_Service_Job__c,
// the size from S3, the sender's NAME from the send's activity event (the uploader id stays blank:
// the event has a Salesforce user id, the column is a profile uuid); then uploaded_at is set to
// the PDF's S3 LastModified so the Files tab dates it to the send, not to today.
// Idempotent: a second run finds nothing to do.

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { registerFileMetadata, findFileMetadataByKey, FILE_METADATA_TABLE } from "../lib/file-access.js";

const APPLY = process.argv.includes("--apply");
const BUCKET = "sfsolproj";
const JOB_OBJECT = "Sundial_Service_Job__c";
const REPORT_RE = /^SUNDIAL\/([A-Za-z0-9]{15,18})\/job-report-(\d+)\.pdf$/;

const s3 = new S3Client({ region: "us-west-1" });
const sb = await getSupabaseClient();

// 1. The jobs: Salesforce's stamps + the activity log's sends (either alone could miss one).
const sfJobs = await sfQuery(`SELECT Id, Client__c FROM ${JOB_OBJECT} WHERE Report_Sent_Count__c > 0 OR Report_PDF_S3_Key__c != null`);
const { data: events, error: evErr } = await sb
  .from("sundial_service_activity")
  .select("job_sf_id, actor_name, details, at")
  .eq("event", "job_report_sent");
if (evErr) throw new Error(`activity read failed: ${evErr.message}`);
const senderByKey = new Map();
for (const e of events || []) if (e.details?.pdfKey) senderByKey.set(e.details.pdfKey, e.actor_name || null);

const tenantByJob = new Map(sfJobs.map((j) => [j.Id, j.Client__c]));
const extra = [...new Set((events || []).map((e) => e.job_sf_id).filter((id) => id && !tenantByJob.has(id)))];
for (let i = 0; i < extra.length; i += 100) {
  const ids = extra.slice(i, i + 100).map((id) => `'${soqlEscapeString(id)}'`).join(",");
  for (const j of await sfQuery(`SELECT Id, Client__c FROM ${JOB_OBJECT} WHERE Id IN (${ids})`)) tenantByJob.set(j.Id, j.Client__c);
}
console.log(`jobs that sent a report: ${tenantByJob.size} (${sfJobs.length} from Salesforce stamps, ${extra.length} more from the activity log)`);

// 2. The PDFs in S3.
const pdfs = [];
for (const jobId of tenantByJob.keys()) {
  let ContinuationToken;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `SUNDIAL/${jobId}/job-report-`, ContinuationToken }));
    for (const o of out.Contents || []) if (REPORT_RE.test(o.Key)) pdfs.push({ key: o.Key, jobId, size: o.Size ?? null, lastModified: o.LastModified ?? null });
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

// 3. Which have no row.
const have = new Set();
for (let i = 0; i < pdfs.length; i += 200) {
  const { data, error } = await sb.from(FILE_METADATA_TABLE).select("s3_key").in("s3_key", pdfs.slice(i, i + 200).map((p) => p.key));
  if (error) throw new Error(`metadata read failed: ${error.message}`);
  for (const r of data || []) have.add(r.s3_key);
}
const missing = pdfs.filter((p) => !have.has(p.key));
const noTenant = missing.filter((p) => !tenantByJob.get(p.jobId));

console.log(`job-report PDFs in S3: ${pdfs.length}`);
console.log(`already registered:    ${pdfs.length - missing.length}`);
console.log(`MISSING a row:         ${missing.length}  (on ${new Set(missing.map((p) => p.jobId)).size} jobs; ${missing.filter((p) => senderByKey.get(p.key)).length} with the sender's name from the activity log)`);
if (noTenant.length) console.log(`  ${noTenant.length} have no Client__c on their job — skipped: ${noTenant.map((p) => p.key).join(", ")}`);
const byTenant = {};
for (const p of missing) byTenant[tenantByJob.get(p.jobId) || "?"] = (byTenant[tenantByJob.get(p.jobId) || "?"] || 0) + 1;
console.log(`  by tenant: ${JSON.stringify(byTenant)}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to register them.");
  process.exit(0);
}

// 4. Register them.
let wrote = 0;
let skipped = 0;
const failed = [];
for (const p of missing) {
  const tenantId = tenantByJob.get(p.jobId);
  if (!tenantId) { skipped++; continue; }
  if (await findFileMetadataByKey(sb, p.key)) { skipped++; continue; } // landed since the read above
  try {
    const row = await registerFileMetadata(sb, {
      s3Key: p.key,
      fileName: p.key.split("/").pop(),
      tenantId,
      sfRecordId: p.jobId,
      sfObjectType: JOB_OBJECT,
      uploadedByUserId: null,
      uploadedByUserName: senderByKey.get(p.key) || "Sundial (job report)",
      fileSizeBytes: p.size,
      mimeType: "application/pdf",
      category: "Job Report",
      subfolder: null,
    });
    if (row?.id && p.lastModified) {
      const { error } = await sb.from(FILE_METADATA_TABLE).update({ uploaded_at: new Date(p.lastModified).toISOString() }).eq("id", row.id);
      if (error) console.log(`  (dated today, not the send: ${p.key}: ${error.message})`);
    }
    wrote++;
  } catch (e) {
    failed.push({ key: p.key, error: e?.message || String(e) });
  }
}
console.log(`\nAPPLIED: ${wrote} row(s) registered, ${skipped} skipped, ${failed.length} failed`);
for (const f of failed) console.log(`  FAILED ${f.key}: ${f.error}`);
process.exitCode = failed.length ? 1 : 0;
