// scripts/backfill-photo-thumbs.mjs — make the ~400 px thumbnails for every job photo that
// predates them (2026-10-22, lib/photo-thumbs.js; D-072 amendment 15).
//
// New photos get their thumbnail at upload. Everything already in S3 — the techs' photos
// since September and the Housecall Pro migration's (photos/hcp/) — gets one here, from
// Tim's machine, S3 → resize → S3. It writes ONLY under SUNDIAL/_cache/photo-thumbs/; the
// originals are read, never written, moved or re-encoded. Nothing touches Salesforce.
//
//   node scripts/backfill-photo-thumbs.mjs                         # DRY RUN: jobs + counts, writes nothing
//   node scripts/backfill-photo-thumbs.mjs --apply --limit 1       # a canary: the first job
//   node scripts/backfill-photo-thumbs.mjs --apply                 # every job (resumable: done thumbs are skipped)
//   options: --job <sfJobId>   --limit <jobs>
//
// The job list comes from sundial_file_metadata (every photo the portal or the HCP media
// copy registered, keyed SUNDIAL/{jobId}/photos/…); each job's photos are then listed from
// S3 itself, so a photo without a metadata row still gets its thumbnail.
//
// Speed: ~1–2 s per 12 MP photo on a laptop. The 475-photo job is ~10 minutes. It can be
// stopped and run again at any point — a thumb that exists is never remade.
// ⚠️ DO NOT PIPE THE OUTPUT through head/tail on a real run — a stop must be seen.

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSupabaseClient } from "../lib/supabase.js";
import { S3_BUCKET, S3_REGION } from "../lib/file-access.js";
import { backfillThumbs, thumbKey, thumbPrefix } from "../lib/photo-thumbs.js";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const APPLY = args.includes("--apply");
const ONLY = opt("--job");
const LIMIT = Number(opt("--limit", "0")) || 0;

const s3 = new S3Client({ region: S3_REGION });
async function list(prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }));
    for (const o of page.Contents || []) if (o.Key && !o.Key.endsWith("/")) out.push({ key: o.Key, size: o.Size ?? 0 });
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}
const deps = {
  getObject: async ({ key }) => {
    const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return { bytes: new Uint8Array(await r.Body.transformToByteArray()) };
  },
  putObject: async ({ key, body, contentType }) => {
    if (!key.startsWith("SUNDIAL/_cache/photo-thumbs/")) throw new Error(`refusing to write outside the thumb cache: ${key}`);
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  },
};

async function jobIds() {
  if (ONLY) return [ONLY];
  const supabase = await getSupabaseClient();
  const ids = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("sundial_file_metadata").select("s3_key").like("s3_key", "SUNDIAL/%/photos/%").order("s3_key").range(from, from + 999);
    if (error) throw new Error(`file metadata read failed: ${error.message}`);
    for (const r of data || []) {
      const id = r.s3_key.split("/")[1];
      if (id && id !== "_cache") ids.add(id);
    }
    if (!data || data.length < 1000) break;
  }
  return [...ids].sort();
}

const jobs = await jobIds();
const todo = LIMIT ? jobs.slice(0, LIMIT) : jobs;
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${jobs.length} job(s) with photos${LIMIT ? `, doing the first ${todo.length}` : ""}`);
const total = { made: 0, copied: 0, skipped: 0, failed: 0, already: 0 };
for (const [i, jobId] of todo.entries()) {
  const photos = await list(`SUNDIAL/${jobId}/photos/`);
  const existing = new Set((await list(thumbPrefix(jobId))).map((t) => t.key));
  if (!APPLY) {
    const jpgs = photos.filter((p) => /\.jpe?g$/i.test(p.key));
    const missing = jpgs.filter((p) => !existing.has(thumbKey(jobId, p.key))).length;
    console.log(`[${i + 1}/${todo.length}] ${jobId}: ${photos.length} photos, ${jpgs.length} JPEG, ${missing} need a thumb`);
    continue;
  }
  const t = await backfillThumbs(deps, jobId, photos, existing, { budgetMs: Number.MAX_SAFE_INTEGER });
  for (const k of Object.keys(total)) total[k] += t[k];
  console.log(`[${i + 1}/${todo.length}] ${jobId}: made ${t.made}, copied ${t.copied}, already ${t.already}, skipped ${t.skipped} (not JPEG), failed ${t.failed}`);
}
if (APPLY) console.log(`DONE — made ${total.made}, copied ${total.copied}, already ${total.already}, skipped ${total.skipped}, failed ${total.failed}`);
