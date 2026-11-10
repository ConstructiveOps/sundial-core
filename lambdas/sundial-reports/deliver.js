// sundial-reports/deliver.js — the email step of a scheduled delivery, and the public download
// link (D-091, Reporting R3, 2026-11-10).
//
// deliverExport(row) runs in the CSV worker right after an export with a `delivery` block is
// marked done or failed (csv.js runExport's onFinished hook):
//   - a FAILED export emails nobody; the failure is recorded on the report (schedule.js
//     recordOutcome — three in a row turn the schedule off);
//   - a file under 8 MB (ATTACH_MAX_BYTES) is ATTACHED (lib/email.js — every attachment BASE64);
//   - 8 MB or more: each recipient gets their OWN link, GET /public/reports/download/{token},
//     good for 7 days. Only the token's SHA-256 is stored (sundial_report_downloads); following
//     it signs a fresh 15-minute S3 link and redirects. (A presigned URL straight from the Lambda
//     cannot last 7 days: it dies with the role's short-lived credentials.)
//   - a GROUPED report also gets its first BODY_ROWS rows drawn in the email body;
//   - ONE email per recipient: nobody sees anyone else's address, one bounce sinks nobody else.
//   - From = the existing sender (EMAIL_FROM), Reply-To = the owner, subject "<name> — <date>".
// What happened (sent / failed per recipient, with the SES message id) is written on the export
// row's `delivery` column — the verify script reads it there.
//
// THE PUBLIC ROUTE is the only route here with no login (an outside recipient has none). It is
// limited per link: MAX_DOWNLOADS_PER_LINK follows, then 429. It logs the token's hash prefix
// and counts — never the token, never an address.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSupabaseClient } from "../../lib/supabase.js";
import { sendEmail } from "../../lib/email.js";
import { REPORTS_BUCKET, REPORTS_REGION, downloadName } from "../../lib/report-csv.js";
import {
  ATTACH_MAX_BYTES, LINK_TTL_MS, MAX_DOWNLOADS_PER_LINK, newDownloadToken, hashToken, isDownloadToken,
} from "../../lib/report-schedule.js";
import { buildDeliveryEmail } from "../../lib/report-email.js";
import { recordOutcome } from "./schedule.js";

export const EXPORTS_TABLE = "sundial_report_exports";
export const DOWNLOADS_TABLE = "sundial_report_downloads";
export const URL_TTL_SECONDS = 15 * 60;
// The API's public address — where a download link points. The same default every script uses.
export const DEFAULT_PUBLIC_API_BASE = "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod";

let s3;
const s3Client = () => (s3 ??= new S3Client({ region: REPORTS_REGION }));
const apiBase = () => (process.env.REPORTS_PUBLIC_API_BASE || DEFAULT_PUBLIC_API_BASE).replace(/\/+$/, "");

async function readObject(key) {
  const out = await s3Client().send(new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: key }));
  return new Uint8Array(await out.Body.transformToByteArray());
}

/** A grouped report's first rows for the email body, or null (never a reason to fail). */
async function bodyTable(supabase, row, d) {
  if (!d.bodyWire || !Array.isArray(d.bodyOutput)) return null;
  try {
    const { data, error } = await supabase.rpc("sundial_report_run", { p_client_sf_id: row.client_sf_id, p_def: d.bodyWire });
    if (error) throw new Error(error.message);
    return { output: d.bodyOutput, rows: data?.rows ?? [], more: data?.truncated === true };
  } catch (err) {
    console.warn(`reports deliver: body table skipped for ${row.id}:`, err?.message || String(err));
    return null;
  }
}

async function writeDelivery(supabase, exportId, delivery) {
  const { error } = await supabase.from(EXPORTS_TABLE).update({ delivery }).eq("id", exportId);
  if (error) console.error("reports deliver: could not record the delivery:", error.message);
}

/**
 * The worker's hook. `row` is the export row as the worker just left it (status, s3_key,
 * row_count, truncated, as_of, bytes). Returns the delivery record, or null (not a delivery).
 */
export async function deliverExport(row, { now = () => new Date() } = {}) {
  const d = row?.job?.delivery;
  if (!d) return null;
  const supabase = await getSupabaseClient();
  const recipients = Array.isArray(d.to) ? d.to : [];
  const record = d.kind !== "to_me";

  if (row.status !== "done") {
    const code = row.error_code || "CSV_FAILED";
    const delivery = { status: "failed", code, sent: 0, failed: recipients.length, results: [], finishedAt: now().toISOString() };
    await writeDelivery(supabase, row.id, delivery);
    if (record) await recordOutcome(supabase, d.reportId, { ok: false, code, exportId: row.id });
    console.log(JSON.stringify({ delivery: "failed", exportId: row.id, reportId: d.reportId, kind: d.kind, code }));
    return delivery;
  }

  const size = Number.isFinite(row.bytes) ? row.bytes : null;
  const attach = size !== null && size < ATTACH_MAX_BYTES;
  const fileName = downloadName(row.report_type, new Date(row.created_at ?? now()));
  let bytes = null;
  if (attach) {
    try {
      bytes = await readObject(row.s3_key);
    } catch (err) {
      console.error(`reports deliver: could not read ${row.id}'s file:`, err?.message || String(err));
    }
  }
  const attached = attach && bytes !== null;
  const table = await bodyTable(supabase, row, d);
  const expiresAt = new Date(now().getTime() + LINK_TTL_MS);

  const results = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    let downloadUrl = null;
    if (!attached) {
      const token = newDownloadToken();
      const { error } = await supabase.from(DOWNLOADS_TABLE).insert({
        token_hash: hashToken(token), export_id: row.id, client_sf_id: row.client_sf_id, expires_at: expiresAt.toISOString(), download_count: 0,
      });
      if (error) {
        console.error("reports deliver: could not make a download link:", error.message);
        results.push({ i, ok: false, messageId: null, error: "LINK_FAILED" });
        continue;
      }
      downloadUrl = `${apiBase()}/public/reports/download/${token}`;
    }
    const mail = buildDeliveryEmail({
      reportName: d.reportName, runDate: d.runDate, ownerName: d.owner?.name ?? null, asOf: row.as_of ?? null,
      rowCount: row.row_count, truncated: row.truncated === true, fileName,
      attached, downloadUrl, expiresAt: attached ? null : expiresAt.toISOString(),
      reportUrl: d.reportUrl ?? null, table,
    });
    const res = await sendEmail({
      to: r.email, subject: mail.subject, html: mail.html, text: mail.text,
      replyTo: d.owner?.email || undefined,
      attachments: attached ? [{ fileName, contentType: "text/csv; charset=utf-8", content: bytes }] : undefined,
    });
    results.push({ i, ok: res.ok === true, messageId: res.ok ? res.messageId ?? null : null, error: res.ok ? null : "SEND_FAILED" });
  }

  const sent = results.filter((x) => x.ok).length;
  const status = recipients.length > 0 && sent === recipients.length ? "sent" : sent > 0 ? "partial" : "failed";
  const code = status === "sent" ? null : status === "partial" ? "SOME_SENDS_FAILED" : (results.find((x) => x.error)?.error ?? "SEND_FAILED");
  const delivery = { status, code, sent, failed: recipients.length - sent, skipped: d.skipped ?? 0, attached, results, finishedAt: now().toISOString() };
  await writeDelivery(supabase, row.id, delivery);
  if (record) await recordOutcome(supabase, d.reportId, { ok: sent > 0, partial: sent > 0 && sent < recipients.length, code, exportId: row.id });
  console.log(JSON.stringify({ delivery: status, exportId: row.id, reportId: d.reportId, kind: d.kind, sent, failed: recipients.length - sent, attached, rows: row.row_count }));
  return delivery;
}

// --- the public download ------------------------------------------------------------------
const page = (status, title, line) => ({
  statusCode: status,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
  body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1f2937"><h1 style="font-size:18px">${title}</h1><p>${line}</p></body></html>`,
});

/**
 * GET /public/reports/download/{token} — no login; the token is the credential. Unknown →
 * 404, expired → 410, followed MAX_DOWNLOADS_PER_LINK times → 429; else 302 to a fresh
 * 15-minute S3 link. Logged by the hash's first 12 characters only.
 */
export async function publicDownload(token, { now = new Date() } = {}) {
  if (!isDownloadToken(token)) return page(404, "Link not found", "This download link is not valid.");
  const hash = hashToken(token);
  const tag = hash.slice(0, 12);
  const supabase = await getSupabaseClient();
  const { data: link, error } = await supabase.from(DOWNLOADS_TABLE).select("*").eq("token_hash", hash).maybeSingle();
  if (error) {
    console.error("reports download: lookup failed:", error.message);
    return page(500, "Something went wrong", "Please try again in a minute.");
  }
  if (!link) {
    console.log(JSON.stringify({ download: "unknown", hash: tag }));
    return page(404, "Link not found", "This download link is not valid.");
  }
  if (Date.parse(link.expires_at) <= now.getTime()) {
    console.log(JSON.stringify({ download: "expired", hash: tag }));
    return page(410, "Link expired", "This download link has expired. Ask the person who sent the report for a new one.");
  }
  const count = link.download_count ?? 0;
  if (count >= MAX_DOWNLOADS_PER_LINK) {
    console.warn(JSON.stringify({ download: "limit", hash: tag, count }));
    return page(429, "Download limit reached", "This link has been used too many times. Ask the person who sent the report for a new one.");
  }
  const { data: ex, error: exErr } = await supabase
    .from(EXPORTS_TABLE).select("id, status, s3_key, report_type, created_at").eq("id", link.export_id).eq("client_sf_id", link.client_sf_id).maybeSingle();
  if (exErr || !ex || ex.status !== "done" || !ex.s3_key) {
    console.log(JSON.stringify({ download: "no_file", hash: tag }));
    return page(404, "File not found", "This report file is no longer available.");
  }
  // Count it. Conditional on the count read: a concurrent follow just counts once (the limit
  // is a brake, not an exact meter).
  await supabase.from(DOWNLOADS_TABLE)
    .update({ download_count: count + 1, last_download_at: now.toISOString() })
    .eq("token_hash", hash).eq("download_count", count);
  const url = await getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: REPORTS_BUCKET,
      Key: ex.s3_key,
      ResponseContentDisposition: `attachment; filename="${downloadName(ex.report_type, new Date(ex.created_at))}"`,
      ResponseContentType: "text/csv; charset=utf-8",
    }),
    { expiresIn: URL_TTL_SECONDS }
  );
  console.log(JSON.stringify({ download: "ok", hash: tag, count: count + 1 }));
  return { statusCode: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }, body: "" };
}
