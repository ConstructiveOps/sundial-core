// Call-recording archival for the Welcome Call.
//
// Retell keeps the recording behind a URL that EXPIRES. That single fact is why this
// module exists: without archiving, `recording_url` in the Salesforce log is a link
// that works today and 404s when someone actually needs it — which is exactly when a
// customer disputes what they agreed to.
//
// Archiving into the normal Sundial file convention (`SUNDIAL/{sf_record_id}/…` in
// the `sfsolproj` bucket) buys three surfaces for free, with no extra code:
//   - the portal Files tab (which lists that prefix straight from S3)
//   - Salesforce, via XFiles Pro reading the same prefix
//   - Harmon's Dropbox mirror, via the S3 PUT event on the same bucket
// See docs/file-storage.md. Getting the key right IS the integration.
//
// EVERY PATH HERE IS BEST-EFFORT AND NON-THROWING. The recording is valuable but the
// verification status is the point of the call; a Retell CDN hiccup must never cost
// us the Salesforce writeback. Callers get a result object, never an exception.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  S3_BUCKET,
  S3_REGION,
  S3_PREFIX,
  sanitizeFileName,
  registerFileMetadata,
  findFileMetadataByKey,
} from "../../lib/file-access.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { phoenixDate } from "./format.js";

export const s3 = new S3Client({ region: S3_REGION });

export const RECORDING_MIME = "audio/mpeg";
export const RECORDING_CATEGORY = "Welcome Call Recording";
/** Recordings are written by the system, not a portal user, and the Files tab shows
 *  this string in the "uploaded by" column. */
export const RECORDING_UPLOADER = "Wattson (system)";
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";

/**
 * Holding prefix for recordings we cannot attach yet — a rep-form call whose customer
 * has not been identified (or does not exist in Salesforce at all).
 *
 * The leading underscore is deliberate: it is NOT a Salesforce id, so it can never
 * collide with a real record folder, and it sorts away from them in any S3 browser.
 * XFiles Pro resolves folders by record id and simply never looks here.
 */
export const ORPHAN_PREFIX = `${S3_PREFIX}/_orphan-welcome-calls`;

// A Welcome Call recording is a phone call: mono, a few minutes, a few MB. The cap is
// a blast radius limit, not a real expectation — the whole file is buffered in Lambda
// memory, so an unexpectedly huge object would OOM the function and take the
// Salesforce writeback down with it.
const MAX_RECORDING_BYTES = 50 * 1024 * 1024; // 50 MB
const DOWNLOAD_TIMEOUT_MS = 20000;

/** Canonical key for an attached recording. */
export function attachedRecordingKey(sfRecordId, dateStr, attemptNo) {
  const name = sanitizeFileName(
    `welcome-call-${dateStr}-attempt-${attemptNo}.mp3`
  );
  return `${S3_PREFIX}/${sfRecordId}/${name}`;
}

/** Canonical key for an orphan recording sitting in the holding prefix. */
export function orphanRecordingKey(callId) {
  return `${ORPHAN_PREFIX}/${sanitizeFileName(String(callId))}.mp3`;
}

/** Canonical key an orphan recording gets when the sweep later matches it. */
export function matchedRecordingKey(sfRecordId, dateStr, callId) {
  const name = sanitizeFileName(
    `welcome-call-${dateStr}-${String(callId)}.mp3`
  );
  return `${S3_PREFIX}/${sfRecordId}/${name}`;
}

/**
 * Normalize `metadata.attempt_no` for use in a filename.
 *
 * Falls back to the literal `"x"` when it is absent or not a sane attempt number, so
 * the key stays deterministic and readable rather than growing an `undefined`. A
 * rep-form call has no attempt number at all — `welcome-call-2026-08-17-attempt-x.mp3`
 * says that honestly.
 */
export function normalizeAttemptNo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1000 ? String(n) : "x";
}

/**
 * Fetch the recording bytes.
 *
 * NO CREDENTIALS ARE SENT. `recording_url` arrives inside the webhook payload, and
 * even though that payload is HMAC-verified, attaching our Retell API key to a URL
 * taken from a request body would hand the key to whatever host it names. The URL is
 * also required to be https for the same defense-in-depth reason.
 *
 * @returns {Promise<{ ok: true, body: Buffer, size: number }|{ ok: false, reason: string }>}
 */
export async function downloadRecording(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: "recording_url is not a URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `refusing non-https recording_url (${parsed.protocol})` };
  }

  let resp;
  try {
    resp = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: `download failed: ${e?.message || String(e)}` };
  }
  if (!resp.ok) {
    return { ok: false, reason: `download HTTP ${resp.status}` };
  }

  // Check the advertised length before buffering, so an absurd object is rejected
  // rather than read into memory first.
  const advertised = Number(resp.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_RECORDING_BYTES) {
    return { ok: false, reason: `recording too large (${advertised} bytes)` };
  }

  let body;
  try {
    body = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return { ok: false, reason: `read failed: ${e?.message || String(e)}` };
  }
  if (body.length === 0) return { ok: false, reason: "recording was empty" };
  if (body.length > MAX_RECORDING_BYTES) {
    return { ok: false, reason: `recording too large (${body.length} bytes)` };
  }
  return { ok: true, body, size: body.length };
}

/** PUT bytes at a key. Deterministic keys mean a redelivery overwrites in place. */
async function putRecording(key, body) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: RECORDING_MIME,
    })
  );
}

/**
 * Register a recording in `sundial_file_metadata`, skipping the insert when a row for
 * that key already exists.
 *
 * Best effort by design (matching the copy-to-solar and budget-snapshot writers): the
 * deployed Files tab lists straight from S3, so the recording is visible regardless.
 * This keeps the documented metadata-backed design in sync and gives the file its
 * category and uploader.
 *
 * @returns {Promise<"registered"|"already_registered"|"failed">}
 */
export async function registerRecordingMetadata({
  key,
  fileName,
  tenantId,
  sfRecordId,
  size,
  description,
}) {
  try {
    const supabase = await getSupabaseClient();
    const existing = await findFileMetadataByKey(supabase, key);
    if (existing) return "already_registered";
    await registerFileMetadata(supabase, {
      s3Key: key,
      fileName,
      tenantId: tenantId ?? null,
      sfRecordId,
      sfObjectType: CUSTOMER_SF_OBJECT,
      uploadedByUserId: null, // no portal user placed this call
      uploadedByUserName: RECORDING_UPLOADER,
      fileSizeBytes: size ?? null,
      mimeType: RECORDING_MIME,
      category: RECORDING_CATEGORY,
      description: description ?? null,
      subfolder: null,
    });
    return "registered";
  } catch (e) {
    console.error(`welcome-call: recording metadata failed for ${key}:`, e?.message || e);
    return "failed";
  }
}

/**
 * Archive the recording for one analyzed call.
 *
 * Two destinations, decided by whether the call carries a Salesforce record:
 *
 *   ATTACHED (`sfRecordId` given) → `SUNDIAL/{id}/welcome-call-{date}-attempt-{n}.mp3`
 *     plus a `sundial_file_metadata` row, so it appears on the record's Files tab, in
 *     XFiles Pro, and in the Dropbox mirror.
 *
 *   ORPHAN (no `sfRecordId`) → `SUNDIAL/_orphan-welcome-calls/{call_id}.mp3` and NO
 *     metadata row. There is no record to attach it to, and a metadata row with a null
 *     `sf_record_id` would be invisible to every list query anyway — a row nobody can
 *     reach is worse than no row, because it looks like the file is registered. The
 *     `/welcome-call/orphan-match` endpoint promotes it once the Zap identifies the
 *     customer.
 *
 * NEVER THROWS. Every failure resolves to `{ ok: false, reason }` and is logged at
 * ERROR with the call_id and the (still-live) recording_url so the file can be
 * retrieved by hand.
 *
 * @returns {Promise<{ ok: boolean, skipped?: true, key?: string, size?: number,
 *                     metadata?: string, orphan?: boolean, reason?: string }>}
 */
export async function archiveRecording({ call, sfRecordId, tenantId, now = new Date() }) {
  const callId = call?.call_id ?? null;
  const url = call?.recording_url ?? null;

  // A call that never connected has no recording. Not a failure — the common case for
  // a no-answer, and it must stay silent or every unanswered call logs an error.
  if (url == null || String(url).trim() === "") {
    return { ok: true, skipped: true, reason: "no recording_url" };
  }

  try {
    const dl = await downloadRecording(url);
    if (!dl.ok) {
      console.error(
        `welcome-call: recording download failed (call_id=${callId}, url=${url}): ${dl.reason}`
      );
      return { ok: false, reason: dl.reason };
    }

    if (!sfRecordId) {
      // Orphan: park it. The key is derived from call_id alone, so the sweep can find
      // it later with nothing but the ledger row.
      const key = orphanRecordingKey(callId ?? "unknown");
      await putRecording(key, dl.body);
      console.log(`welcome-call: orphan recording stored at ${key} (${dl.size} bytes)`);
      return { ok: true, key, size: dl.size, orphan: true, metadata: "not_applicable" };
    }

    const attemptNo = normalizeAttemptNo(call?.metadata?.attempt_no);
    const key = attachedRecordingKey(sfRecordId, phoenixDate(now), attemptNo);
    await putRecording(key, dl.body);

    const metadata = await registerRecordingMetadata({
      key,
      fileName: key.slice(key.lastIndexOf("/") + 1),
      tenantId,
      sfRecordId,
      size: dl.size,
      description: callId ? `Retell call ${callId}` : null,
    });

    console.log(
      `welcome-call: recording archived at ${key} (${dl.size} bytes, metadata=${metadata})`
    );
    return { ok: true, key, size: dl.size, metadata, orphan: false };
  } catch (e) {
    // The URL is logged deliberately: it is still live for a while, and that window is
    // the manual-retrieval path.
    console.error(
      `welcome-call: recording archival FAILED (call_id=${callId}, url=${url}): ` +
        `${e?.message || String(e)}`
    );
    return { ok: false, reason: e?.message || String(e) };
  }
}
