// ENTRY POINT 2 — POST /webhooks/retell
//
// Retell's lifecycle webhook. Three events arrive per call (call_started,
// call_ended, call_analyzed); only call_analyzed carries the analysis, so it is the
// only one that does any work. The other two are acked and dropped.
//
// TWO CONSUMERS, ONE DELIVERY — and the order between them is the whole design:
//
//   1. FORWARD TO ZAPIER FIRST, unconditionally, before Salesforce is touched.
//      The Zap is the BILLING LEDGER: it records every analyzed call, including
//      calls this Lambda never placed (a rep can start one from a form, for a
//      customer who may not have a Salesforce record yet). Forwarding first means
//      billing captures the call even if the Salesforce writeback then fails.
//   2. A FORWARD FAILURE NEVER BLOCKS THE WRITEBACK. Three attempts with backoff,
//      then the full payload is logged at ERROR so it can be replayed by hand, and
//      processing continues. Losing a ledger entry is a billing correction; losing
//      the verification result is a customer who never gets called again.
//
// NO SUPABASE JWT. The caller is Retell — a machine with no portal user, so
// resolveIdentity has nothing to verify and MUST NOT be used (same reasoning as
// sundial-aurora-webhook). The ONLY gate is the x-retell-signature HMAC.
//
// Value-safety: the signing secret and the computed/received signatures are never
// logged. The payload IS logged on a final forward failure — that is a deliberate
// trade for replayability, and it is why that path is ERROR-level and rare.

import crypto from "node:crypto";
import { sfQuery, soqlEscapeString, describeObject } from "../../lib/salesforce.js";
import { resolveCustomerFields } from "./fields.js";
import { MAX_ATTEMPTS, phoenixStamp } from "./format.js";
import { archiveRecording } from "./recording.js";
import { applyWelcomeCallUpdate, prependLogLine, CUSTOMER_SF_OBJECT } from "./writeback.js";

export const SIGNATURE_HEADER = "x-retell-signature";

/** Retell lifecycle events. Only `call_analyzed` is processed. */
const EVENT_ANALYZED = "call_analyzed";
//
// `transcript_updated` was added after the first live delivery (2026-08-18): Retell
// streams it repeatedly DURING a call, and every one was logging a WARN about an
// unrecognized event. It is a known event we deliberately ignore, not a surprise, and
// a long call would otherwise bury the real lines in noise.
//
// Note an unknown event is still acked (200) rather than 4xx'd — a rejection would put
// Retell into its retry ladder over something we simply don't care about.
const ACK_ONLY_EVENTS = new Set(["call_started", "call_ended", "transcript_updated"]);

// Zapier forward retry ladder: initial attempt + 2 retries.
const FORWARD_ATTEMPTS = 3;
const FORWARD_BACKOFF_MS = [500, 2000];
const FORWARD_TIMEOUT_MS = 8000;

// Log lines are bounded so one pathological analysis payload cannot eat the 32k log
// field (and take the status update down with it — see writeback.prependLogLine).
const LOG_SEGMENT_MAX = 200;
const LOG_NOTES_MAX = 300;

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/** Retell's replay window: the signature timestamp must be within 5 minutes. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/**
 * Verify the `x-retell-signature` header, per Retell's documented scheme
 * (https://docs.retellai.com/features/secure-webhook):
 *
 *     header  = `v={unix_ms_timestamp},d={hex_digest}`
 *     digest  = HMAC-SHA256(raw_body + timestamp, API_KEY)   // concatenated, no separator
 *     window  = timestamp must be within ±5 minutes of now
 *
 * THREE THINGS THIS GOT WRONG BEFORE (fixed 2026-08-18 against a real delivery):
 *   1. the timestamp is part of the signed material, not decoration
 *   2. the key is the Retell API KEY, not a separate signing secret
 *   3. `v=` holds the TIMESTAMP; the digest is in `d=`. The old parser stripped a
 *      leading `v=` and compared the remainder as a digest, which rejected 100% of
 *      real deliveries while every self-signed test passed
 *
 * The bare-hex / `v=<hex>` legacy forms are deliberately NOT accepted any more. They
 * were our own invention, nothing real ever sent them, and honouring a body-only HMAC
 * would sidestep the replay window this now enforces.
 *
 * THE RAW BODY MATTERS. The HMAC covers the exact bytes Retell signed —
 * re-serializing parsed JSON changes key order and whitespace and will never match.
 * The handler passes the body through untouched (base64-decoded first when API
 * Gateway flags it, which restores the original bytes).
 *
 * Compared in constant time via fixed-length digests, so neither the key nor the
 * expected digest leaks through timing or a length check.
 *
 * @param {Buffer|string} rawBody
 * @param {string} header       - the x-retell-signature value
 * @param {string} secret       - the Retell API key
 * @param {number} [now]        - injectable clock, for tests
 * @returns {{ ok: boolean, reason: string }} reason is for logging, never for the caller
 */
export function verifySignature(rawBody, header, secret, now = Date.now()) {
  if (typeof secret !== "string" || secret === "") return { ok: false, reason: "no_secret" };
  if (typeof header !== "string" || header.trim() === "") return { ok: false, reason: "no_header" };

  const m = /^v=(\d+),d=([0-9a-fA-F]+)$/.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed_header" };

  const timestamp = m[1];
  const provided = m[2].toLowerCase();

  // Replay window BEFORE the HMAC: a stale-but-validly-signed delivery is exactly
  // what this is here to stop, so it must not be able to pass on digest alone.
  // Checked in both directions — a clock ahead of ours is as suspect as one behind.
  if (Math.abs(now - Number(timestamp)) > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([body, Buffer.from(timestamp, "utf8")]))
    .digest("hex");

  return constantTimeEquals(provided, expected)
    ? { ok: true, reason: "ok" }
    : { ok: false, reason: "digest_mismatch" };
}

/**
 * Describe the SHAPE of a signature header for diagnostics — never its content.
 *
 * Exists because the gate is deliberately silent about values, which is right for
 * security and useless when a real provider delivery is rejected and nobody can say
 * why. It earned its keep immediately: the first real Retell delivery logged
 * `parts=2 [v=len13, d=len64]`, which is what identified the true header format
 * (`v=<unix_ms>,d=<hex>`) and the three-way bug in the old verifier.
 *
 * The expected healthy shape is now `parts=2 [v=len13, d=len64]`. Anything else —
 * `parts=1`, a bare hex, a `bodyBytes` that doesn't match what was signed — names the
 * failure without exposing a value.
 *
 * Emits key names and value LENGTHS only. A length cannot reconstruct a secret, and
 * the digest is a public value anyway — but keeping values out entirely means this
 * can never become the thing that leaks one.
 *
 * @returns {string} e.g. `parts=2 [t=len10, v=len64] bodyBytes=1234`
 */
export function describeSignatureShape(header, rawBody) {
  const bodyBytes = Buffer.isBuffer(rawBody)
    ? rawBody.length
    : Buffer.byteLength(String(rawBody ?? ""), "utf8");

  if (typeof header !== "string" || header.trim() === "") {
    return `header absent or empty bodyBytes=${bodyBytes}`;
  }

  const parts = header.trim().split(",").map((p) => p.trim()).filter(Boolean);
  const shapes = parts.map((p) => {
    const eq = p.indexOf("=");
    if (eq > 0) {
      const key = p.slice(0, eq);
      // Key names are format identifiers (v, t, s1...), not secrets — but bound the
      // length so a hostile header can't flood the log.
      return `${key.slice(0, 12)}=len${p.length - eq - 1}`;
    }
    return /^[0-9a-f]+$/i.test(p) ? `bare-hex=len${p.length}` : `unkeyed=len${p.length}`;
  });

  return `parts=${parts.length} [${shapes.join(", ")}] bodyBytes=${bodyBytes}`;
}

/**
 * Constant-time equality that is also length-safe.
 *
 * `crypto.timingSafeEqual` throws when the two buffers differ in length, and
 * comparing raw lengths first would leak the expected length. Hashing both sides to a
 * fixed 32 bytes removes both problems: the digests are always the same size, and only
 * identical inputs produce identical digests.
 *
 * Shared by the Retell signature check above and the Zap shared-secret gate in
 * index.js, so neither can drift into an early-exit comparison.
 */
export function constantTimeEquals(a, b) {
  const ha = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const hb = crypto.createHash("sha256").update(String(b), "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Zapier forward (the billing ledger)
// ---------------------------------------------------------------------------

/**
 * POST the full payload to the Zapier Catch Hook, with retries.
 * Resolves — never throws — so the caller cannot accidentally let a ledger problem
 * abort the Salesforce writeback.
 *
 * @returns {Promise<{ ok: boolean, attempts: number, reason?: string }>}
 */
export async function forwardToZapier(hookUrl, payload, rawBody, { sleep = defaultSleep } = {}) {
  if (!hookUrl) {
    console.error(
      "welcome-call: ZAPIER_RESULTS_HOOK_URL is not set — the billing ledger did NOT " +
        "receive this call. Payload logged below for manual replay.\n" +
        safePayloadForLog(rawBody)
    );
    return { ok: false, attempts: 0, reason: "not_configured" };
  }

  // Forward the RAW body when we have it, so the Zap sees byte-for-byte what Retell
  // sent (and could verify the signature itself if it ever needs to).
  const body = rawBody != null ? rawBody : JSON.stringify(payload);

  let lastReason = "";
  for (let attempt = 1; attempt <= FORWARD_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      if (resp.ok) return { ok: true, attempts: attempt };
      lastReason = `HTTP ${resp.status}`;
    } catch (e) {
      lastReason = e?.message || String(e);
    }
    if (attempt < FORWARD_ATTEMPTS) await sleep(FORWARD_BACKOFF_MS[attempt - 1]);
  }

  // Final failure. The payload goes to CloudWatch at ERROR so it can be replayed into
  // the Zap by hand — this is the only place we log a full webhook body.
  console.error(
    `welcome-call: Zapier forward FAILED after ${FORWARD_ATTEMPTS} attempts (${lastReason}). ` +
      `Payload for manual replay:\n${safePayloadForLog(body)}`
  );
  return { ok: false, attempts: FORWARD_ATTEMPTS, reason: lastReason };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safePayloadForLog(body) {
  const s = typeof body === "string" ? body : JSON.stringify(body ?? {});
  // CloudWatch truncates enormous lines anyway; cap so one payload can't dominate.
  return s.length > 20000 ? `${s.slice(0, 20000)}…[truncated]` : s;
}

/**
 * Re-serialize the payload with `s3_recording_key` added, for the orphan forward.
 *
 * This is the ONE case where the ledger does not receive Retell's raw bytes: the Zap
 * needs to know where the parked recording landed. The key is technically derivable
 * from `call_id`, but a derived key cannot tell the sweep whether the upload actually
 * succeeded — an explicit field can, and its absence means "there is nothing to
 * match".
 */
function withRecordingKey(payload, key) {
  return JSON.stringify({ ...payload, s3_recording_key: key });
}

// ---------------------------------------------------------------------------
// Outcome -> Welcome_Call_Status__c
// ---------------------------------------------------------------------------

/** Fold a verification_result value to a comparable token. */
export function normalizeOutcome(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

const OUTCOME_STATUS = new Map([
  ["passed", "Verified"],
  ["partial", "Verified - Exceptions"],
  ["failed", "Verified - Exceptions"],
  ["callback_requested", "Verified - Exceptions"],
  ["refusal", "Refused"],
  ["wrong_person", "No Answer"],
  ["voicemail", "No Answer"],
  ["no_answer", "No Answer"],
]);

/**
 * Map an analysis outcome to a Salesforce status.
 *
 * The "No Answer" bucket is the only one the attempt ceiling applies to, because it
 * is the only one that would otherwise be retried. A Verified or Refused call is
 * finished regardless of how many attempts it took.
 *
 * An UNRECOGNIZED outcome resolves to "Verified - Exceptions", not "No Answer".
 * That is the fail-safe direction: Exceptions parks the record for a human to read,
 * while No Answer would silently queue another call on a result we did not
 * understand. The one exception is a voicemail flagged by `in_voicemail` with no
 * usable verification_result — that IS a no-answer and should be retried.
 *
 * @param {string} verificationResult
 * @param {{ attempts?: number, inVoicemail?: boolean }} ctx
 * @returns {{ status: string, outcome: string, recognized: boolean }}
 */
export function mapOutcomeToStatus(verificationResult, { attempts = 0, inVoicemail = false } = {}) {
  const outcome = normalizeOutcome(verificationResult);
  let status = OUTCOME_STATUS.get(outcome);
  let recognized = status != null;

  if (!recognized) {
    status = inVoicemail && outcome === "" ? "No Answer" : "Verified - Exceptions";
  }

  if (status === "No Answer" && attempts >= MAX_ATTEMPTS) {
    status = "Failed - Max Attempts";
  }

  return { status, outcome: outcome || (inVoicemail ? "voicemail" : "unknown"), recognized };
}

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

/** Retell nests the call under `call` on lifecycle webhooks; tolerate a flat shape. */
export function extractCall(payload) {
  return payload?.call && typeof payload.call === "object" ? payload.call : payload || {};
}

function listToText(v) {
  if (v == null) return "";
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    .filter((s) => s && s.trim() !== "")
    .join("; ");
}

function clip(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t === "") return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The six per-topic confirmation flags in custom_analysis_data. Only the FALSE ones
 * go in the log: "which checks did not pass" is the actionable half, and listing six
 * `true`s on every successful call would bury the exceptions.
 *
 * This is distinct from `mismatched_items` and not redundant with it — a MISMATCH is
 * "the customer gave a different value", an unpassed CHECK is "we never got an
 * answer". They point at different follow-ups.
 */
const CONFIRMATION_FLAGS = [
  ["identity_confirmed", "identity"],
  ["email_confirmed", "email"],
  ["system_details_confirmed", "system"],
  ["financial_terms_confirmed", "financials"],
  ["utility_bill_understood", "utility bill"],
  ["usage_change_understood", "usage change"],
];

/**
 * Build the result log line. Contains the call_id, which is what the idempotency
 * guard below matches on, and the literal marker "Result:" that distinguishes a
 * finished call from the "Call placed" line written when it was dialed.
 */
export function buildResultLogLine({
  stamp,
  attemptNo,
  outcome,
  status,
  analysis,
  call,
  recordingKey = null,
}) {
  const parts = [
    stamp,
    `Attempt ${attemptNo}`,
    `Result: ${outcome}`,
    `Status: ${status}`,
  ];

  const notConfirmed = CONFIRMATION_FLAGS.filter(([key]) => analysis?.[key] !== true).map(
    ([, label]) => label
  );
  if (notConfirmed.length) parts.push(`not confirmed: ${notConfirmed.join(", ")}`);

  const mismatches = clip(listToText(analysis?.mismatched_items), LOG_SEGMENT_MAX);
  parts.push(`mismatches: ${mismatches || "none"}`);

  const unconfirmed = clip(listToText(analysis?.unconfirmed_items), LOG_SEGMENT_MAX);
  if (unconfirmed) parts.push(`unconfirmed: ${unconfirmed}`);

  const notes = clip(analysis?.follow_up_notes, LOG_NOTES_MAX);
  if (notes) parts.push(`notes: ${notes}`);

  if (call?.in_voicemail === true) parts.push("voicemail: yes");

  const recording = clip(call?.recording_url, 500);
  if (recording) parts.push(`recording=${recording}`);

  // The Retell URL above EXPIRES; this key does not. When both are present the key is
  // the one to use, and its presence is also the record that archival succeeded.
  if (recordingKey) parts.push(`archived=${recordingKey}`);

  parts.push(`call_id=${call?.call_id ?? "unknown"}`);
  return parts.join(" · ");
}

/**
 * Has this call_id already been recorded with a terminal outcome?
 *
 * Matches a log line carrying BOTH the call_id and the "Result:" marker. Matching on
 * the call_id alone would be wrong — the "Call placed" line carries the same id, so
 * the very first legitimate result would be discarded as a duplicate.
 */
export function alreadyProcessed(logText, callId) {
  if (!callId || typeof logText !== "string" || logText === "") return false;
  const needle = `call_id=${callId}`;
  return logText
    .split("\n")
    .some((line) => line.includes(needle) && line.includes("Result:"));
}

// ---------------------------------------------------------------------------
// The processing path
// ---------------------------------------------------------------------------

/**
 * Handle one verified call_analyzed payload.
 *
 * @returns {Promise<{ status: number, body: object }>} the HTTP answer for Retell
 */
export async function processCallAnalyzed(payload, rawBody, cfg, { now = new Date() } = {}) {
  const call = extractCall(payload);
  const callId = call?.call_id ?? null;
  const recordId = call?.metadata?.sf_record_id ?? null;

  // ---- ORPHAN PATH: park the recording, THEN forward, then stop -----------
  //
  // The recording step runs BEFORE the forward here, and only here. That is the
  // opposite of the attached path below, and it is forced by what the ledger needs:
  // for a rep-form call the ledger row is the ONLY trace of the call, and the sweep
  // that later matches it to a customer needs the recording's key. There is nothing
  // to put in the payload unless the upload has already happened.
  //
  // The cost is that an orphan's ledger row waits on a download bounded at 20 s. That
  // is acceptable because the step cannot throw and cannot skip the forward — a failed
  // archival simply forwards without `s3_recording_key`, which the sweep reads as
  // "no recording to attach".
  if (!recordId) {
    const rec = await archiveRecording({ call, sfRecordId: null, now });
    const bodyToForward =
      rec.ok && rec.key ? withRecordingKey(payload, rec.key) : rawBody;
    const orphanForward = await forwardToZapier(
      cfg.zapierResultsHookUrl,
      payload,
      bodyToForward
    );
    console.log(
      `welcome-call webhook: call_analyzed with no sf_record_id (call_id=${callId}) — ` +
        `forwarded to the ledger only (forwarded=${orphanForward.ok}, ` +
        `recording=${rec.key ?? rec.reason ?? "none"}).`
    );
    return {
      status: 200,
      body: {
        received: true,
        forwarded: orphanForward.ok,
        salesforce: "not_applicable",
        recording: rec.key ?? null,
      },
    };
  }

  // ---- 1) Billing ledger first, always -----------------------------------
  const forwarded = await forwardToZapier(cfg.zapierResultsHookUrl, payload, rawBody);

  // ---- 2) Salesforce writeback -------------------------------------------
  const describe = await describeObject(CUSTOMER_SF_OBJECT);
  const schema = resolveCustomerFields(describe);
  if (schema.missingRequired.length) {
    console.error(
      `welcome-call webhook: Sundial_Customer__c missing ${schema.missingRequired.join(", ")} — ` +
        `cannot record the result for ${recordId}.`
    );
    return {
      status: 200, // nothing Retell can do about our schema; don't drive its retries
      body: { received: true, forwarded: forwarded.ok, salesforce: "schema_incomplete" },
    };
  }

  const soql =
    `SELECT ${schema.selectFields.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' LIMIT 1`;
  const record = (await sfQuery(soql))?.[0] ?? null;
  if (!record) {
    console.warn(
      `welcome-call webhook: metadata pointed at ${recordId}, which no longer exists — ` +
        `ledger forward stands, nothing written.`
    );
    return {
      status: 200,
      body: { received: true, forwarded: forwarded.ok, salesforce: "record_not_found" },
    };
  }

  const get = schema.reader(record);
  const logApi = schema.apiName("welcomeCallLog");
  const statusApi = schema.apiName("welcomeCallStatus");
  const tenantId = get("client") ?? null;
  const existingLog = record[logApi];

  // ---- Idempotency: Retell may redeliver ----------------------------------
  if (alreadyProcessed(existingLog, callId)) {
    console.log(
      `welcome-call webhook: call_id=${callId} already recorded on ${recordId} — ack and skip.`
    );
    return {
      status: 200,
      body: { received: true, forwarded: forwarded.ok, salesforce: "duplicate" },
    };
  }

  const analysis = call?.call_analysis?.custom_analysis_data ?? {};
  const attempts = Number(get("welcomeCallAttempts")) || 0;
  const { status, outcome } = mapOutcomeToStatus(analysis?.verification_result, {
    attempts,
    inVoicemail: call?.in_voicemail === true,
  });

  // The attempt this result belongs to. metadata.attempt_no is what the placing side
  // stamped; the stored counter is the fallback for a call placed some other way.
  const attemptNo = Number(call?.metadata?.attempt_no) || attempts || 1;

  // ---- Recording: after the ledger forward, before the writeback lands -----
  //
  // Sequenced here so the archived key can go INTO the log line the writeback is about
  // to save — one Salesforce write, not two. `archiveRecording` never throws, so the
  // writeback below runs whatever happens to the audio.
  //
  // Placing it after the idempotency check means a redelivery does not re-download a
  // few MB to overwrite an identical object. The trade: if the very first delivery
  // stored the status but failed the recording, a redelivery will not retry the audio.
  // The Retell URL is in the log line and in the ledger row for exactly that case.
  const recording = await archiveRecording({
    call,
    sfRecordId: record.Id,
    tenantId,
    now,
  });

  const line = buildResultLogLine({
    stamp: phoenixStamp(now),
    attemptNo,
    outcome,
    status,
    analysis,
    call,
    recordingKey: recording.ok ? recording.key : null,
  });
  const nextLog = prependLogLine(existingLog, line);

  const sfFields = { [statusApi]: status, [logApi]: nextLog };

  try {
    const applied = await applyWelcomeCallUpdate({
      recordId: record.Id,
      tenantId,
      sfFields,
      cacheValues: { welcome_call_status: status, welcome_call_log: nextLog },
      broadcastPayload: {
        call_id: callId,
        outcome,
        recording_url: call?.recording_url ?? null,
        recording_key: recording.ok ? recording.key ?? null : null,
        call_summary: call?.call_analysis?.call_summary ?? null,
      },
    });
    console.log(
      `welcome-call RESULT ${recordId}: ${outcome} -> ${status} (attempt ${attemptNo}, ` +
        `call_id=${callId}, forwarded=${forwarded.ok}, cache=${applied.cache}, ` +
        `realtime=${applied.realtime}, recording=${recording.key ?? recording.reason ?? "none"})`
    );
    return {
      status: 200,
      body: {
        received: true,
        forwarded: forwarded.ok,
        salesforce: "updated",
        welcomeCallStatus: status,
        recording: recording.ok ? recording.key ?? null : null,
      },
    };
  } catch (e) {
    // 5xx ON PURPOSE so Retell retries: the ledger already has the call, and the
    // idempotency guard makes a redelivery safe (it re-reads the log, finds no
    // "Result:" line for this call_id, and writes it once).
    console.error(
      `welcome-call webhook: Salesforce writeback FAILED for ${recordId} (call_id=${callId}): ` +
        `${e?.message || String(e)}${e?.sfBody ? ` SF: ${e.sfBody}` : ""}`
    );
    return {
      status: 500,
      body: { received: true, forwarded: forwarded.ok, error: "salesforce_writeback_failed" },
    };
  }
}

/** Is this an event we deliberately ignore? */
export function isAckOnlyEvent(name) {
  return ACK_ONLY_EVENTS.has(String(name || "").trim());
}

export { EVENT_ANALYZED };
