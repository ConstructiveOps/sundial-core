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

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
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

/**
 * Bounded retry for the recording download.
 *
 * Retell can answer `call_analyzed` before the recording object behind
 * `recording_url` is actually servable — a 403/404 that becomes a 200 seconds later.
 * A single attempt turns that race into a permanently missing recording, so we retry.
 *
 * `budgetMs` is the part that matters. The Lambda's own ceiling is 60 s and the
 * orphan path still has a ledger forward and a Salesforce round-trip to make after
 * this, so retries are only affordable for failures that came back FAST. A 20 s
 * timeout has already spent the budget: retrying it would trade a missing recording
 * for a dead Lambda, which also loses the writeback. The loop therefore refuses to
 * start an attempt it cannot pay for — which in practice means three tries for a
 * not-ready-yet 404 and exactly one for a hung connection.
 *
 * Mutable so the test suite can zero the delay; nothing in production writes to it.
 */
export const downloadRetryPolicy = {
  attempts: 3,
  delayMs: 3000,
  budgetMs: 30000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this HTTP status worth a second look?
 *
 * 403 and 404 are in the list because that is what a not-yet-published recording
 * looks like from the CDN, which is the whole reason the retry exists. A 400 or 401
 * says the request itself is wrong and will be just as wrong in three seconds.
 */
function isRetryableStatus(status) {
  return status === 403 || status === 404 || status === 408 || status === 425 ||
    status === 429 || status >= 500;
}

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
 * ONE attempt at fetching the recording bytes. `downloadRecording` wraps this in the
 * bounded retry; nothing else should call it directly.
 *
 * NO CREDENTIALS ARE SENT. `recording_url` arrives inside the webhook payload, and
 * even though that payload is HMAC-verified, attaching our Retell API key to a URL
 * taken from a request body would hand the key to whatever host it names. The URL is
 * also required to be https for the same defense-in-depth reason.
 *
 * @returns {Promise<{ ok: true, body: Buffer, size: number }
 *                   |{ ok: false, reason: string, retryable?: boolean }>}
 */
async function downloadOnce(parsed) {
  let resp;
  try {
    resp = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    // Network reset, DNS blip, or our own AbortSignal firing. All transient.
    return { ok: false, reason: `download failed: ${e?.message || String(e)}`, retryable: true };
  }
  if (!resp.ok) {
    return {
      ok: false,
      reason: `download HTTP ${resp.status}`,
      retryable: isRetryableStatus(resp.status),
    };
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
    return { ok: false, reason: `read failed: ${e?.message || String(e)}`, retryable: true };
  }
  // A zero-byte answer is the other shape of "not written yet", so it retries too.
  if (body.length === 0) return { ok: false, reason: "recording was empty", retryable: true };
  if (body.length > MAX_RECORDING_BYTES) {
    return { ok: false, reason: `recording too large (${body.length} bytes)` };
  }
  return { ok: true, body, size: body.length };
}

/**
 * Fetch the recording bytes, retrying a transient failure within a fixed budget.
 *
 * See `downloadRetryPolicy` for why the budget, not the attempt count, is the real
 * limit. Never throws; a permanent failure resolves to `{ ok: false, reason }`.
 *
 * @returns {Promise<{ ok: true, body: Buffer, size: number }|{ ok: false, reason: string }>}
 */
export async function downloadRecording(url, policy = downloadRetryPolicy) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: "recording_url is not a URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `refusing non-https recording_url (${parsed.protocol})` };
  }

  const startedAt = Date.now();
  const attempts = Math.max(1, Number(policy?.attempts) || 1);
  const delayMs = Math.max(0, Number(policy?.delayMs) || 0);
  const budgetMs = Number(policy?.budgetMs) > 0 ? Number(policy.budgetMs) : Infinity;

  let last = { ok: false, reason: "no attempt was made" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await downloadOnce(parsed);
    if (last.ok) {
      if (attempt > 1) {
        console.log(`welcome-call: recording download succeeded on attempt ${attempt}.`);
      }
      return last;
    }
    if (!last.retryable || attempt === attempts) break;

    // Refuse an attempt the remaining budget cannot cover — see downloadRetryPolicy.
    const projected = Date.now() - startedAt + delayMs + DOWNLOAD_TIMEOUT_MS;
    if (projected > budgetMs) {
      console.warn(
        `welcome-call: not retrying the recording download (${last.reason}) — ` +
          `another attempt would exceed the ${budgetMs} ms budget.`
      );
      break;
    }
    console.warn(
      `welcome-call: recording download attempt ${attempt} failed (${last.reason}) — ` +
        `retrying in ${delayMs} ms.`
    );
    await sleep(delayMs);
  }
  return { ok: false, reason: last.reason };
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
 * HEAD one key. Returns the object's metadata, or null when it is not there.
 *
 * A missing object and a broken S3 call must never look alike here: callers use this
 * to decide whether a key is safe to WRITE INTO A CUSTOMER-FACING LOG, and treating a
 * throttling error as "absent" would either lose a real recording or publish a key
 * that points at nothing. Anything that is not a clean 404 is re-thrown.
 */
export async function headObject(key) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch (e) {
    const status = e?.$metadata?.httpStatusCode;
    if (e?.name === "NotFound" || e?.name === "NoSuchKey" || status === 404) return null;
    throw e;
  }
}

/**
 * Is this object really there?
 *
 * The gate in front of every `Recording:` line we write. Non-throwing on purpose: a
 * HEAD that errors answers "cannot confirm", and an unconfirmable key is treated
 * exactly like an absent one — the log says `unavailable` rather than naming a key
 * nobody has verified.
 */
export async function objectExists(key) {
  try {
    return (await headObject(key)) != null;
  } catch (e) {
    console.error(
      `welcome-call: could not confirm ${key} exists: ${e?.message || String(e)}`
    );
    return false;
  }
}

/**
 * When was this call actually recorded, per Retell?
 *
 * The recording FILENAME carries a date, and that date must be the day the office
 * dialed — not the day a sweep or a repair happened to run. On the normal promote
 * path the holding object's LastModified supplies it; once that object is gone (or
 * never existed) the call's own timestamps are the only honest source left. Getting
 * this wrong writes a second file under a second name for one conversation.
 */
export function callRecordedAt(call, fallback = new Date()) {
  for (const v of [call?.start_timestamp, call?.end_timestamp]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return new Date(n);
  }
  return fallback;
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

    // Confirm before anyone is told the key. A PUT that resolved is normally proof
    // enough, but this key is about to be written into Welcome_Call_Log__c, where it
    // outlives every other trace of the call — so it is checked rather than assumed.
    const verified = await objectExists(key);
    if (!verified) {
      console.error(
        `welcome-call: PUT ${key} reported success but the object could not be ` +
          `confirmed (call_id=${callId}) — the log will say unavailable.`
      );
    }

    const metadata = await registerRecordingMetadata({
      key,
      fileName: key.slice(key.lastIndexOf("/") + 1),
      tenantId,
      sfRecordId,
      size: dl.size,
      description: callId ? `Retell call ${callId}` : null,
    });

    console.log(
      `welcome-call: recording archived at ${key} (${dl.size} bytes, ` +
        `metadata=${metadata}, verified=${verified})`
    );
    return { ok: true, key, size: dl.size, metadata, orphan: false, verified };
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

/**
 * Put a recording at a key we already know, straight from Retell.
 *
 * THE REPAIR PATH. The normal flow parks a rep-form recording in the holding prefix
 * and the sweep copies it onto the record; this covers the case where that chain has
 * a hole in it — the holding object never landed, or it landed and both it and the
 * copy are gone. Retell still has the audio behind a fresh `recording_url`, and the
 * sweep has just fetched the call to build the backfill, so the bytes are one request
 * away and everything else needed is already in hand.
 *
 * The caller supplies `key` rather than deriving one here, because a repair must
 * reproduce the key the log ALREADY NAMES. Inventing a new one would leave the old
 * line pointing at nothing and add a second name for one conversation.
 *
 * NEVER THROWS — same contract as `archiveRecording`. A repair that fails leaves the
 * Salesforce writeback untouched.
 *
 * @returns {Promise<{ ok: boolean, key?: string, size?: number, metadata?: string,
 *                     reason?: string }>}
 */
export async function healRecordingToKey({
  call,
  sfRecordId,
  tenantId,
  key,
  description = null,
}) {
  const callId = call?.call_id ?? null;
  const url = call?.recording_url ?? null;
  if (url == null || String(url).trim() === "") {
    return { ok: false, reason: "no recording_url" };
  }

  try {
    const dl = await downloadRecording(url);
    if (!dl.ok) {
      console.error(
        `welcome-call: recording heal download failed (call_id=${callId}, url=${url}): ${dl.reason}`
      );
      return { ok: false, reason: dl.reason };
    }

    await putRecording(key, dl.body);
    if (!(await objectExists(key))) {
      console.error(
        `welcome-call: recording heal PUT ${key} could not be confirmed (call_id=${callId}).`
      );
      return { ok: false, reason: "upload could not be confirmed" };
    }

    const metadata = await registerRecordingMetadata({
      key,
      fileName: key.slice(key.lastIndexOf("/") + 1),
      tenantId,
      sfRecordId,
      size: dl.size,
      description,
    });

    console.log(
      `welcome-call: recording HEALED at ${key} (${dl.size} bytes, metadata=${metadata}, ` +
        `call_id=${callId})`
    );
    return { ok: true, key, size: dl.size, metadata };
  } catch (e) {
    console.error(
      `welcome-call: recording heal FAILED (call_id=${callId}, url=${url}): ` +
        `${e?.message || String(e)}`
    );
    return { ok: false, reason: e?.message || String(e) };
  }
}
