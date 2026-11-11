// sundial-reports/csv.js — the CSV export (D-089, Reporting R1b; docs/reporting-module.md §6.7).
//
//   POST /reports/csv              a report definition → 202 { exportId, status: "queued" }
//   GET  /reports/{id}/csv         the same for a saved report (saved.js calls startExport)
//   GET  /reports/csv/{exportId}   → { status, url, rowCount, truncated, stripped, asOf, expiresAt }
//   { task: "csv", exportId }      the worker: this Lambda invoking itself (InvocationType Event)
//
// WHY ASYNCHRONOUS (measured 2026-11-04, Tim's decision 9). One 5,000-row page of customers
// costs 0.4–0.8 s end to end (12 → 50 columns, ~1.9 MB of JSON), but the database re-sorts
// everything before the page for every OFFSET: the page at 34,000 took 2.1 s in Postgres alone
// with 50 columns. A 50,000-row export is 10 of those, a long-text export 25 pages of 2,000 —
// it does not fit reliably inside API Gateway's 29 s, so the request only queues it. The
// worker has the Lambda's whole timeout (300 s; it stops itself 20 s before the end with
// CSV_TOO_SLOW rather than be killed mid-upload).
//
// MEMORY. Nothing holds the whole file: each page (≤ 5,000 rows, ≤ ~2 MB of JSON; 2,000 rows
// when long text is selected) is turned into CSV text and appended to an 8 MB part buffer;
// a full buffer is uploaded as one part of an S3 multipart upload and dropped. Peak memory is
// one page + one part (~20 MB), so 1,024 MB is for CPU (Lambda CPU scales with memory), not
// for space. A file under 8 MB is one PutObject.
//
// WHERE: sfsolproj, REPORTS/<client_sf_id>/<yyyy-mm-dd>/<exportId>.csv (lib/report-csv.js
// exportKey) — never SUNDIAL/ (XFiles Pro / Dropbox read that tree; these files hold contact
// details). Encrypted at rest (SSE-S3); deleted by the bucket after 7 days (REPORTS/ lifecycle
// rule). The URL is a presigned GET made when the status is read, good for 15 minutes.
//
// LINKS (D-089 am. 1). An UNGROUPED export ends each row with a "<alias> link" column per
// record alias with a portal page (lib/report-csv.js linkColumns). The origin is the tenant's
// portal address — lib/tenant-settings.js portalUrlFor, the one the invite and mention emails
// use: the primary tenant's PORTAL_BASE_URL (default below), any other tenant's
// `sundial/brand` portalUrl. It is resolved ONCE, when the export is queued, and stored in the
// job; a tenant with no address gets an export without link columns, never another tenant's.
//
// SUMMARY (D-093, showDetails). The group value is the first column and each aggregate its own
// trailing column; a subtotal line follows each group's last row (a group split across two
// pages gets one, from the function's per-group numbers over ALL its rows) and a grand-total
// line ends the file — lib/report-csv.js createSummaryCsv. The first page asks for totals.
//
// WHO: reports.read, then the export row's owner in its tenant — anyone else's export is 404
// RECORD_NOT_FOUND, the saved-report rule. NEVER LOGGED: a row, a value, a filter, the URL.

import { S3Client, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getSupabaseClient } from "../../lib/supabase.js";
import { jsonResponse } from "../../lib/http.js";
import { DENY } from "../../lib/access.js";
import { normalizeDefinition } from "../../lib/report-def.js";
import { reportType } from "../../lib/report-types.js";
import { csvHeader, csvRows, exportKey, downloadName, linkColumns, cleanOrigin, summaryCsvHeader, createSummaryCsv, REPORTS_BUCKET, REPORTS_REGION } from "../../lib/report-csv.js";
import { createTenantSettings } from "../../lib/tenant-settings.js";
import { isUuid } from "../../lib/saved-reports.js";

export const EXPORTS_TABLE = "sundial_report_exports";
export const URL_TTL_SECONDS = 15 * 60;
export const PART_BYTES = 8 * 1024 * 1024;
export const STOP_BEFORE_END_MS = 20_000;
// A queued / running export older than this was lost (the worker died without marking it).
export const LOST_AFTER_MS = 10 * 60_000;

// The primary tenant's portal (the same default as lib/auth-email.js / sundial-user-admin).
export const DEFAULT_PORTAL_BASE_URL = "https://sundial.harmonelectric.net";

let s3;
let lambda;
let settings;
const tenantSettings = () => (settings ??= createTenantSettings());

/** The tenant's portal origin ("https://host"), or null when it has none (D-078: never another tenant's). */
export async function tenantPortalOrigin(tenantSlug) {
  const primary = cleanOrigin(process.env.PORTAL_BASE_URL || DEFAULT_PORTAL_BASE_URL);
  try {
    return cleanOrigin(await tenantSettings().portalUrlFor(tenantSlug, primary));
  } catch (err) {
    console.warn("reports csv: portal origin lookup failed:", err?.message || String(err));
    return null;
  }
}

/** The portal origin an export's links open, or null (grouped, no link columns, not configured). */
export async function exportOrigin(type, wire, tenantSlug) {
  if (wire.grouped || !type || linkColumns(type).length === 0) return null;
  return tenantPortalOrigin(tenantSlug);
}
const s3Client = () => (s3 ??= new S3Client({ region: REPORTS_REGION }));
const lambdaClient = () => (lambda ??= new LambdaClient({}));

const notFound = (cors) => jsonResponse(404, cors, { error: "not_found", code: DENY.RECORD_NOT_FOUND });

/**
 * Validate a definition for CSV and queue its export. Shared by POST /reports/csv and
 * GET /reports/{id}/csv. `def` is the definition; `reportId` the saved report, if any.
 */
export async function startExport({ def, reportId = null, tenantId, tenantSlug = null, profileId, heldGates, cors, now = new Date() }) {
  const n = normalizeDefinition(def, { heldGates, now, mode: "csv" });
  if (!n.ok) return jsonResponse(n.status, cors, n.body);

  const portalOrigin = await exportOrigin(reportType(def.type), n.wire, tenantSlug);
  const job = { type: def.type, wire: n.wire, output: n.output, rowLimit: n.rowLimit, stripped: n.stripped, objects: n.objects, portalOrigin, ...summaryJob(n) };
  const q = await queueExport({ tenantId, ownerProfileId: profileId, reportId, reportType: def.type, job });
  if (q.error === "QUEUE_FAILED") return jsonResponse(500, cors, { error: "server_error" });
  if (q.error) return jsonResponse(502, cors, { error: "worker_invoke_failed", code: "WORKER_INVOKE_FAILED" });
  const data = { id: q.exportId };
  console.log(JSON.stringify({ csv: "queued", exportId: data.id, report: def.type, saved: !!reportId, columns: n.output.length, rowLimit: n.rowLimit }));
  return jsonResponse(202, cors, { exportId: data.id, status: "queued", stripped: n.stripped });
}

/** What a summary export (D-093) also stores in its job: the group column and the aggregates. */
export function summaryJob(n) {
  return n.summary ? { group: n.group, totals: n.totals } : {};
}

/**
 * Write a queued export row and start the worker (this Lambda, invoked by itself). Shared by
 * startExport and the scheduled delivery (schedule.js, D-091), so an emailed report goes down
 * exactly the path a downloaded one does. Returns { exportId } or { error, exportId? }:
 * QUEUE_FAILED (no row), WORKER_INVOKE_FAILED (the row is marked failed).
 */
export async function queueExport({ tenantId, ownerProfileId, reportId = null, reportType: typeKey, job, beforeInvoke = null }) {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from(EXPORTS_TABLE)
    .insert({ client_sf_id: tenantId, owner_profile_id: ownerProfileId, report_id: reportId, report_type: typeKey, status: "queued", job })
    .select("id")
    .single();
  if (error || !data?.id) {
    console.error("reports csv: could not queue the export:", error?.message || "no id");
    return { error: "QUEUE_FAILED" };
  }
  // The scheduled delivery stamps the export id on its report here, BEFORE the worker can
  // finish and look for it there (D-091).
  if (typeof beforeInvoke === "function") await beforeInvoke(data.id);
  try {
    await lambdaClient().send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event", // fire and forget: the worker runs after this response
      Payload: Buffer.from(JSON.stringify({ task: "csv", exportId: data.id })),
    }));
  } catch (err) {
    console.error("reports csv: self-invoke failed:", err?.message || String(err));
    await supabase.from(EXPORTS_TABLE).update({ status: "failed", error_code: "WORKER_INVOKE_FAILED", finished_at: new Date().toISOString() }).eq("id", data.id);
    return { error: "WORKER_INVOKE_FAILED", exportId: data.id };
  }
  return { exportId: data.id };
}

/** GET /reports/csv/{exportId}. */
export async function exportStatus({ exportId, tenantId, profileId, cors, now = new Date() }) {
  if (!isUuid(exportId)) return notFound(cors);
  const supabase = await getSupabaseClient();
  const { data: row, error } = await supabase
    .from(EXPORTS_TABLE)
    .select("*")
    .eq("id", exportId)
    .eq("client_sf_id", tenantId)
    .maybeSingle();
  if (error) {
    console.error("reports csv: status read failed:", error.message);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  // Exports are never shared: someone else's is the same 404 as one that does not exist.
  if (!row || row.owner_profile_id !== profileId) return notFound(cors);

  const base = { exportId: row.id, type: row.report_type, stripped: row.job?.stripped ?? [], createdAt: row.created_at };
  // A delivery (D-091, send-now): how the emailing went — counts only, never an address.
  if (row.job?.delivery) {
    const d = row.delivery;
    base.delivery = d
      ? { status: d.status, sent: d.sent ?? 0, failed: d.failed ?? 0, skipped: d.skipped ?? 0, attached: d.attached ?? null, code: d.code ?? null }
      : { status: "pending" };
  }
  if (row.status === "done") {
    const url = await getSignedUrl(
      s3Client(),
      new GetObjectCommand({
        Bucket: REPORTS_BUCKET,
        Key: row.s3_key,
        ResponseContentDisposition: `attachment; filename="${downloadName(row.report_type, new Date(row.created_at))}"`,
        ResponseContentType: "text/csv; charset=utf-8",
      }),
      { expiresIn: URL_TTL_SECONDS }
    );
    return jsonResponse(200, cors, {
      ...base, status: "done", url, rowCount: row.row_count, truncated: row.truncated === true, asOf: row.as_of,
      expiresAt: new Date(now.getTime() + URL_TTL_SECONDS * 1000).toISOString(),
    });
  }
  if (row.status === "failed") return jsonResponse(200, cors, { ...base, status: "failed", code: row.error_code || "CSV_FAILED" });
  if (now.getTime() - Date.parse(row.created_at) > LOST_AFTER_MS) {
    return jsonResponse(200, cors, { ...base, status: "failed", code: "CSV_EXPORT_LOST" });
  }
  return jsonResponse(200, cors, { ...base, status: row.status, url: null, rowCount: null, truncated: null });
}

/** Buffers CSV text and uploads it as one object, or as 8 MB multipart parts. */
export class S3CsvWriter {
  constructor(client, { key, fileName }) {
    this.client = client;
    this.params = {
      Bucket: REPORTS_BUCKET,
      Key: key,
      ContentType: "text/csv; charset=utf-8",
      ContentDisposition: `attachment; filename="${fileName}"`,
      ServerSideEncryption: "AES256",
    };
    this.chunks = [];
    this.size = 0;
    this.uploadId = null;
    this.parts = [];
    this.bytes = 0;
  }
  async write(text) {
    const b = Buffer.from(text, "utf8");
    this.chunks.push(b);
    this.size += b.length;
    this.bytes += b.length;
    if (this.size >= PART_BYTES) await this.#flushPart();
  }
  async #flushPart() {
    if (!this.uploadId) {
      const r = await this.client.send(new CreateMultipartUploadCommand(this.params));
      this.uploadId = r.UploadId;
    }
    const PartNumber = this.parts.length + 1;
    const body = Buffer.concat(this.chunks);
    this.chunks = [];
    this.size = 0;
    const r = await this.client.send(new UploadPartCommand({ Bucket: this.params.Bucket, Key: this.params.Key, UploadId: this.uploadId, PartNumber, Body: body }));
    this.parts.push({ ETag: r.ETag, PartNumber });
  }
  async finish() {
    if (!this.uploadId) {
      await this.client.send(new PutObjectCommand({ ...this.params, Body: Buffer.concat(this.chunks) }));
      return;
    }
    if (this.size > 0) await this.#flushPart();
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.params.Bucket, Key: this.params.Key, UploadId: this.uploadId, MultipartUpload: { Parts: this.parts },
    }));
  }
  async abort() {
    if (!this.uploadId) return;
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.params.Bucket, Key: this.params.Key, UploadId: this.uploadId }));
    } catch (err) {
      console.warn("reports csv: abort multipart failed:", err?.message || String(err));
    }
  }
}

class ExportError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * The worker. Claims the queued row (so a retried async invoke never runs twice), pages
 * sundial_report_run with the stored wire definition, streams the CSV to S3, and marks the row.
 * `remainingMs` is the Lambda context's clock.
 */
export async function runExport(exportId, { remainingMs = () => Infinity, asOfFor = async () => null, now = () => new Date(), onFinished = null } = {}) {
  if (!isUuid(exportId)) return { ok: false, skipped: "bad id" };
  const supabase = await getSupabaseClient();
  const { data: claimed, error: claimErr } = await supabase
    .from(EXPORTS_TABLE)
    .update({ status: "running", started_at: now().toISOString() })
    .eq("id", exportId)
    .eq("status", "queued")
    .select("*");
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const row = claimed?.[0];
  if (!row) {
    console.log(JSON.stringify({ csv: "skipped", exportId, why: "not queued" }));
    return { ok: false, skipped: "not queued" };
  }

  const started = Date.now();
  const job = row.job;
  const type = reportType(job.type);
  const key = exportKey(row.client_sf_id, row.id, new Date(row.created_at));
  const writer = new S3CsvWriter(s3Client(), { key, fileName: downloadName(job.type, new Date(row.created_at)) });
  let rows = 0;
  let pages = 0;
  let truncated = false;
  try {
    if (!type) throw new ExportError("UNKNOWN_TYPE");
    const asOf = await asOfFor(supabase, job.objects ?? []);
    // An export queued before D-089 am. 1 has no portalOrigin: no link columns.
    const origin = !job.wire.grouped ? cleanOrigin(job.portalOrigin) : null;
    const links = origin ? linkColumns(type) : [];
    // A summary (D-093): group first, aggregates after the columns, a subtotal after each
    // group and a grand total at the end. The grand totals ride on the FIRST page only.
    const summary = job.wire.details === true && job.group ? createSummaryCsv({ output: job.output, group: job.group, totals: job.totals ?? [], links, origin }) : null;
    let grand = null;
    await writer.write(summary ? summaryCsvHeader(job.output, job.group, job.totals ?? [], type, links) : csvHeader(job.output, type, links));
    for (;;) {
      if (remainingMs() < STOP_BEFORE_END_MS) throw new ExportError("CSV_TOO_SLOW");
      const limit = Math.min(job.wire.limit, job.rowLimit - rows);
      const { data, error } = await supabase.rpc("sundial_report_run", { p_client_sf_id: row.client_sf_id, p_def: { ...job.wire, limit, offset: rows, totals: !!summary && rows === 0 } });
      if (error) {
        const msg = String(error.message || "");
        throw new ExportError(msg.startsWith("sundial_report_run:") ? "REPORT_CATALOG_MISMATCH" : "CSV_FAILED", msg);
      }
      const page = data?.rows ?? [];
      pages += 1;
      if (summary) {
        if (!Array.isArray(data?.groups)) throw new ExportError("REPORT_ENGINE_OUTDATED");
        if (rows === 0) grand = { aggregates: data?.aggregates ?? {}, totalRows: data?.totalRows ?? null };
        if (page.length) await writer.write(summary.page({ rows: page, records: data?.records ?? null, groups: data.groups }));
      } else if (page.length) {
        await writer.write(csvRows(page, job.output, { records: data?.records ?? null, links, origin }));
      }
      rows += page.length;
      if (!data?.truncated) break;
      if (rows >= job.rowLimit) {
        truncated = true; // more rows matched than the export may hold
        break;
      }
    }
    if (summary) await writer.write(summary.end(grand ?? {}));
    await writer.finish();
    await supabase.from(EXPORTS_TABLE).update({
      status: "done", s3_key: key, row_count: rows, truncated, as_of: asOf, finished_at: now().toISOString(),
    }).eq("id", row.id);
    console.log(JSON.stringify({ csv: "done", exportId: row.id, report: job.type, rows, pages, truncated, bytes: writer.bytes, ms: Date.now() - started }));
    await finished(onFinished, { ...row, status: "done", s3_key: key, row_count: rows, truncated, as_of: asOf, bytes: writer.bytes });
    return { ok: true, rows, pages, truncated, key };
  } catch (err) {
    await writer.abort();
    const code = err instanceof ExportError ? err.code : "CSV_FAILED";
    console.error(`reports csv: export ${row.id} failed (${code}) after ${rows} rows / ${pages} pages / ${Date.now() - started} ms:`, err?.message || String(err));
    await supabase.from(EXPORTS_TABLE).update({ status: "failed", error_code: code, row_count: rows, finished_at: now().toISOString() }).eq("id", row.id);
    await finished(onFinished, { ...row, status: "failed", error_code: code, row_count: rows });
    return { ok: false, code, rows };
  }
}

/**
 * After an export is marked done / failed: the caller's hook (D-091 — the scheduled delivery
 * emails it). A hook that throws never changes the export's own result.
 */
async function finished(onFinished, row) {
  if (typeof onFinished !== "function") return;
  try {
    await onFinished(row);
  } catch (err) {
    console.error(`reports csv: after-export hook failed for ${row.id}:`, err?.message || String(err));
  }
}
