// ENTRY POINT 3 — POST /welcome-call/orphan-match
//
// A rep can start a Welcome Call from a form, for a customer who may not exist in
// Salesforce yet. Those calls reach the webhook with no `sf_record_id`, so their
// recording is parked in `SUNDIAL/_orphan-welcome-calls/{call_id}.mp3` and the ledger
// row is the only trace. A Zapier sweep later works out which customer the call
// belonged to and calls this endpoint to promote the recording onto that record.
//
// AUTH IS A SHARED SECRET, NOT A PORTAL JWT (`X-Sundial-Zap-Secret` vs
// `ZAP_ORPHAN_MATCH_SECRET`). The caller is a Zap: a machine with no Sundial user, so
// `resolveIdentity` has nothing to verify. Same shape as the Aurora doorbell and the
// Retell webhook — constant-time compare, and an unset secret rejects everything
// rather than accepting everything.
//
// IDEMPOTENCY IS THE HARD PART, because the operation ends by DELETING its own input.
// A retry therefore cannot re-derive the destination key: that key embeds the holding
// object's LastModified date, and the holding object is gone. So the retry path
// LOOKS FOR the destination instead — any `welcome-call-*-{call_id}.mp3` already under
// the record — and reports `already_matched`. It also re-attempts the log line if that
// is what failed last time, so a partial run converges instead of silently losing the
// note.

import {
  S3_BUCKET,
  S3_PREFIX,
  encodeCopySource,
  sanitizeFileName,
} from "../../lib/file-access.js";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { sfQuery, soqlEscapeString, describeObject } from "../../lib/salesforce.js";
import { resolveCustomerFields } from "./fields.js";
import { phoenixDate, phoenixStamp, TERMINAL_STATUSES } from "./format.js";
import { getConfig } from "./config.js";
import { getCall } from "./retell.js";
import {
  alreadyProcessed,
  buildResultLogEntry,
  extractCall,
  resolveCallStatus,
  ENTRY_MARKER,
} from "./webhook.js";
import {
  s3,
  callRecordedAt,
  headObject,
  healRecordingToKey,
  objectExists,
  orphanRecordingKey,
  matchedRecordingKey,
  registerRecordingMetadata,
} from "./recording.js";
import { applyWelcomeCallUpdate, prependLogEntry, CUSTOMER_SF_OBJECT } from "./writeback.js";

export const ZAP_SECRET_HEADER = "x-sundial-zap-secret";

const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** The log line this endpoint writes. Also the marker its retry path searches for. */
export function matchLogText(callId) {
  return `rep-form call ${callId} matched, recording attached`;
}

/**
 * Has this call's recording already been promoted onto the record? Looks for any
 * object under `SUNDIAL/{sfRecordId}/` whose filename ends `-{call_id}.mp3`.
 *
 * Searching by suffix rather than reconstructing the key is the whole point: the date
 * segment came from an object that no longer exists.
 */
export async function findMatchedRecording(sfRecordId, callId) {
  const prefix = `${S3_PREFIX}/${sfRecordId}/welcome-call-`;
  const suffix = `-${sanitizeFileName(String(callId))}.mp3`;
  let ContinuationToken;
  do {
    const out = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken })
    );
    for (const obj of out.Contents || []) {
      if (obj.Key && obj.Key.endsWith(suffix)) return obj.Key;
    }
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return null;
}

/**
 * Append the match note to `Welcome_Call_Log__c`, unless it is already there.
 *
 * Skipping when present is what makes the retry path safe to run repeatedly: the Zap
 * can call this endpoint as many times as it likes without stacking identical lines.
 *
 * Best effort — the recording is already attached by the time this runs, so a
 * Salesforce blip must not turn a completed match into a failure.
 *
 * @returns {Promise<"appended"|"already_present"|"failed"|"no_log_field">}
 */
async function appendMatchNote({ record, schema, callId, now }) {
  const logApi = schema.apiName("welcomeCallLog");
  if (!logApi) return "no_log_field";

  const existing = record[logApi];
  const text = matchLogText(callId);
  if (typeof existing === "string" && existing.includes(text)) return "already_present";

  const nextLog = prependLogEntry(existing, `${phoenixStamp(now)} · ${text}`);
  try {
    await applyWelcomeCallUpdate({
      recordId: record.Id,
      tenantId: schema.reader(record)("client") ?? null,
      sfFields: { [logApi]: nextLog },
      cacheValues: { welcome_call_log: nextLog },
      broadcastPayload: { reason: "orphan_recording_matched", call_id: callId },
    });
    return "appended";
  } catch (e) {
    console.error(
      `welcome-call orphan-match: log append failed for ${record.Id} (call_id=${callId}):`,
      e?.message || String(e)
    );
    return "failed";
  }
}

/**
 * Fetch one call from Retell for a repair, with the API-key check folded in.
 *
 * The repair path needs the call for TWO things — the analysis for the backfill and
 * the fresh `recording_url` for the heal — so it is fetched once, up front, and the
 * one result is handed to both. Retell mints a new URL on every read, which is
 * precisely why re-reading works when the webhook's original URL has long expired.
 *
 * Never throws; `getCall` already degrades to a result object.
 */
async function fetchCallForRepair(callId) {
  const cfg = await getConfig();
  if (!cfg.retellApiKey) {
    console.warn(
      `welcome-call orphan-match: no Retell API key configured — cannot repair ${callId}.`
    );
    return { ok: false, status: 0, call: null, error: "no Retell API key", noApiKey: true };
  }
  return await getCall({ apiKey: cfg.retellApiKey, callId });
}

/**
 * Append a one-line correction naming the recording's real key.
 *
 * WHY A NEW LINE RATHER THAN AN EDIT. `Welcome_Call_Log__c` is append-only by
 * convention: entries are evidence, and silently rewriting one destroys the record of
 * what the system believed at the time. When a repair produces a key the log does not
 * already name — because the old entry said `unavailable`, or named a key that turned
 * out to be wrong — the honest fix is a new line saying so, leaving the original
 * visible above it.
 *
 * Idempotent: if the key is already somewhere in the log there is nothing to correct.
 *
 * @returns {Promise<"appended"|"already_correct"|"failed"|"no_log_field">}
 */
async function appendRecordingCorrection({ record, schema, callId, key, now }) {
  const logApi = schema.apiName("welcomeCallLog");
  if (!logApi) return "no_log_field";

  const existing = record[logApi];
  if (typeof existing === "string" && existing.includes(key)) return "already_correct";

  // Deliberately carries NO "Result:" segment — `alreadyProcessed` matches on a line
  // holding both the call_id and that marker, and a correction must not be mistaken
  // for the result entry it is correcting.
  const entry =
    `${ENTRY_MARKER}${phoenixStamp(now)} · recording recovered · ` +
    `call_id=${callId}
Recording: ${key}`;
  const nextLog = prependLogEntry(existing, entry, schema.fieldLength("welcomeCallLog"));

  try {
    await applyWelcomeCallUpdate({
      recordId: record.Id,
      tenantId: schema.reader(record)("client") ?? null,
      sfFields: { [logApi]: nextLog },
      cacheValues: { welcome_call_log: nextLog },
      broadcastPayload: {
        reason: "welcome_call_recording_recovered",
        call_id: callId,
        recording_key: key,
      },
    });
    return "appended";
  } catch (e) {
    console.error(
      `welcome-call orphan-match: recording correction failed for ${record.Id} ` +
        `(call_id=${callId}):`,
      e?.message || String(e)
    );
    return "failed";
  }
}

/**
 * Backfill a rep-form call's FULL result onto the customer record.
 *
 * WHY THIS EXISTS (D-055). A rep-form call reaches the webhook with no
 * `sf_record_id`, so the entire Salesforce writeback is skipped and its analysis —
 * mismatches, follow-ups, the summary — used to live only in the Zapier billing
 * ledger. The sweep then attached the audio and wrote a one-line "matched" note,
 * which told a reader that a call happened but nothing about what was said. Salesforce
 * is the system of record for call RESULTS regardless of how the call started; the
 * ledger is for billing.
 *
 * The sweep hands us only `{call_id, sf_record_id}`, so the analysis is re-read from
 * Retell rather than re-sent by Zapier — same data, same authority the webhook used,
 * which is what lets both paths share `mapOutcomeToStatus` and `buildResultLogEntry`
 * and produce byte-identical entries.
 *
 * STATUS RULES:
 *   - A record already at a TERMINAL status keeps it. A rep-form call is a SECOND
 *     conversation with a customer whose verification may already be settled, and a
 *     sweep running days later must not reopen it. The entry is still appended, marked
 *     so a reader knows why the status doesn't match the result on that line.
 *   - `Welcome_Call_Attempts__c` is NEVER incremented. That counter drives the retry
 *     ceiling for Salesforce-initiated dials; a rep-form call is not one of those, and
 *     counting it would silently consume a customer's retry budget.
 *
 * Best-effort throughout: the recording is already attached by the time this runs, so
 * neither an unreachable Retell nor a Salesforce blip may turn a completed match into
 * a failure.
 *
 * @returns {Promise<{ result: string, status?: string|null, detail?: string }>}
 */
async function backfillCallResult({
  record,
  schema,
  callId,
  now,
  recordingKey,
  prefetched = null,
}) {
  const logApi = schema.apiName("welcomeCallLog");
  const statusApi = schema.apiName("welcomeCallStatus");
  if (!logApi) return { result: "no_log_field" };

  const existingLog = record[logApi];
  // Same guard the webhook uses: a full result entry for this call_id is already here.
  if (alreadyProcessed(existingLog, callId)) return { result: "already_present" };

  // The repair path has already fetched this call (for the heal) and hands it over,
  // so the analysis is never read from Retell twice for one invocation.
  const fetched = prefetched ?? (await fetchCallForRepair(callId));
  if (fetched.noApiKey) return { result: "no_api_key" };
  if (!fetched.ok) {
    console.warn(
      `welcome-call orphan-match: could not fetch ${callId} from Retell ` +
        `(status=${fetched.status}): ${fetched.error} — falling back to the match note.`
    );
    return { result: "fetch_failed", detail: fetched.error ?? "" };
  }

  const call = extractCall(fetched.call);
  const analysis = call?.call_analysis?.custom_analysis_data ?? {};

  // attempts is read ONLY to resolve the No Answer ceiling correctly; it is never
  // written back. Passing it keeps the mapping identical to the webhook's.
  const attempts = Number(schema.reader(record)("welcomeCallAttempts")) || 0;
  // Same decision as the webhook, connection check included — a rep-form call that
  // rang out must not backfill as Verified - Exceptions (call_ae983426…, 2026-09-15).
  const { status: mappedStatus } = resolveCallStatus(call, { attempts });

  const currentStatus = statusApi ? String(record[statusApi] ?? "").trim() : "";
  const isTerminal = TERMINAL_STATUSES.has(currentStatus);

  const entry = buildResultLogEntry({
    stamp: phoenixStamp(now),
    origin: isTerminal
      ? "rep-form call (status unchanged, record already terminal)"
      : "rep-form call",
    // The entry always states the call's OWN result, even when the record keeps its
    // existing status — otherwise the line would misreport what the call found.
    status: mappedStatus,
    analysis,
    call,
    recordingKey,
  });

  const nextLog = prependLogEntry(existingLog, entry, schema.fieldLength("welcomeCallLog"));
  const sfFields = { [logApi]: nextLog };
  const cacheValues = { welcome_call_log: nextLog };
  if (!isTerminal && statusApi) {
    sfFields[statusApi] = mappedStatus;
    cacheValues.welcome_call_status = mappedStatus;
  }

  try {
    await applyWelcomeCallUpdate({
      recordId: record.Id,
      tenantId: schema.reader(record)("client") ?? null,
      sfFields,
      cacheValues,
      broadcastPayload: {
        reason: "rep_form_backfill",
        call_id: callId,
        status: isTerminal ? currentStatus : mappedStatus,
        recording_key: recordingKey ?? null,
        call_summary: call?.call_analysis?.call_summary ?? null,
      },
    });
    return {
      result: isTerminal ? "backfilled_status_unchanged" : "backfilled",
      status: isTerminal ? currentStatus : mappedStatus,
    };
  } catch (e) {
    console.error(
      `welcome-call orphan-match: backfill write failed for ${record.Id} ` +
        `(call_id=${callId}):`,
      e?.message || String(e)
    );
    return { result: "failed" };
  }
}

/**
 * Attach the call result to the record: the full backfill when Retell can supply the
 * analysis, and the one-line match note when it cannot. One log write either way —
 * the backfill entry supersedes the note, so writing both would be duplicate noise.
 */
async function recordMatchOnSalesforce({
  record,
  schema,
  callId,
  now,
  recordingKey,
  prefetched = null,
}) {
  const backfill = await backfillCallResult({
    record,
    schema,
    callId,
    now,
    recordingKey,
    prefetched,
  });
  if (backfill.result === "fetch_failed" || backfill.result === "no_api_key") {
    const note = await appendMatchNote({ record, schema, callId, now });
    return { backfill: backfill.result, log: note, status: null };
  }
  return { backfill: backfill.result, log: backfill.result, status: backfill.status ?? null };
}

/**
 * Promote one orphan recording onto a customer record.
 *
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleOrphanMatch(body, { now = new Date() } = {}) {
  const callId = typeof body?.call_id === "string" ? body.call_id.trim() : "";
  const sfRecordId =
    typeof body?.sf_record_id === "string" ? body.sf_record_id.trim() : "";

  if (!callId || !sfRecordId) {
    return {
      status: 400,
      body: {
        error: "missing_fields",
        code: "MISSING_FIELDS",
        message: "Both call_id and sf_record_id are required.",
      },
    };
  }
  if (!SF_ID_RE.test(sfRecordId)) {
    return { status: 400, body: { error: "invalid_record_id", code: "INVALID_RECORD_ID" } };
  }
  // A call_id that sanitizes to nothing could not have produced a holding key.
  if (!sanitizeFileName(callId)) {
    return { status: 400, body: { error: "invalid_call_id", code: "INVALID_CALL_ID" } };
  }

  // Resolve the customer first: it proves the target exists, and its Client__c is the
  // tenant stamped on the metadata row. There is no caller tenant here (the caller is
  // a Zap), so the record scopes itself — the same model sundial-aurora-inbound uses.
  const describe = await describeObject(CUSTOMER_SF_OBJECT);
  const schema = resolveCustomerFields(describe);
  const soql =
    `SELECT ${schema.selectFields.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(sfRecordId)}' LIMIT 1`;
  const record = (await sfQuery(soql))?.[0] ?? null;
  if (!record) {
    return { status: 404, body: { error: "not_found", code: "RECORD_NOT_FOUND" } };
  }
  const tenantId = schema.reader(record)("client") ?? null;

  const holdingKey = orphanRecordingKey(callId);
  const holding = await headObject(holdingKey);

  // ---- Already done: holding gone, destination present --------------------
  if (!holding) {
    const existingKey = await findMatchedRecording(sfRecordId, callId);
    if (existingKey) {
      // Converge the parts that may have failed last time. All are no-ops when the
      // earlier run completed — the backfill's own idempotency check sees its entry
      // already in the log and skips.
      const attached = await recordMatchOnSalesforce({
        record,
        schema,
        callId,
        now,
        recordingKey: existingKey,
      });
      const metadata = await registerRecordingMetadata({
        key: existingKey,
        fileName: existingKey.slice(existingKey.lastIndexOf("/") + 1),
        tenantId,
        sfRecordId,
        size: null,
        description: `Retell call ${callId} (rep-form, matched)`,
      });
      // The file is here, but an earlier run may have logged it as `unavailable` or
      // under a name that has since changed. Same one-line correction as the repair
      // path — the log has to agree with the bucket.
      let correction = "not_needed";
      if (attached.backfill === "already_present") {
        correction = await appendRecordingCorrection({
          record,
          schema,
          callId,
          key: existingKey,
          now,
        });
      }
      console.log(
        `welcome-call orphan-match: ${callId} already matched to ${sfRecordId} at ${existingKey}`
      );
      return {
        status: 200,
        body: {
          already_matched: true,
          key: existingKey,
          recordId: sfRecordId,
          callId,
          log: attached.log,
          backfill: attached.backfill,
          welcomeCallStatus: attached.status,
          metadata,
          correction,
        },
      };
    }
    // ---- Neither object exists: REPAIR from Retell ------------------------
    //
    // This used to be a flat 404, and that made the endpoint unable to fix the one
    // failure it is best placed to fix. A gap on either side of the chain lands here:
    // the holding upload never happened, or it happened and both it and the copy were
    // later removed (a portal bulk-delete of the record's Files will do exactly that).
    // Either way Retell still has the audio, the sweep still knows the record, and a
    // fresh `recording_url` is one read away — everything the repair needs is already
    // in hand, so refusing to try was the only thing standing between a customer and
    // their recording.
    //
    // The key is rebuilt from the CALL's own timestamp, not from now(). It has to
    // reproduce the name the log may already claim; a repair that invents today's
    // date leaves the old line dangling and files one conversation under two names.
    console.warn(
      `welcome-call orphan-match: no holding object at ${holdingKey} and no matched ` +
        `recording under ${sfRecordId} — attempting to heal from Retell.`
    );

    const fetched = await fetchCallForRepair(callId);
    const fetchedCall = fetched.ok ? extractCall(fetched.call) : null;

    let healed = { ok: false, reason: fetched.error || "call could not be fetched" };
    if (fetchedCall) {
      healed = await healRecordingToKey({
        call: fetchedCall,
        sfRecordId,
        tenantId,
        key: matchedRecordingKey(
          sfRecordId,
          phoenixDate(callRecordedAt(fetchedCall, now)),
          callId
        ),
        description: `Retell call ${callId} (rep-form, recovered)`,
      });
    }
    const healedKey = healed.ok ? healed.key : null;

    // The Salesforce side runs either way: a first-time backfill is worth writing
    // even when the audio is unrecoverable, and it is what makes the status and the
    // analysis land. Only a CONFIRMED key is passed in — `healRecordingToKey` HEADs
    // the object before it reports success — so the entry can never name a file that
    // is not there.
    const attached = await recordMatchOnSalesforce({
      record,
      schema,
      callId,
      now,
      recordingKey: healedKey,
      prefetched: fetched,
    });

    // A repeat run for a call whose result was already logged writes nothing above
    // (that is the idempotency guard doing its job) — so if this run is what finally
    // produced the recording, the existing entry still says `unavailable`, or names a
    // key that no longer holds. One appended line, never an edit.
    let correction = "not_needed";
    if (healedKey && attached.backfill === "already_present") {
      correction = await appendRecordingCorrection({
        record,
        schema,
        callId,
        key: healedKey,
        now,
      });
    }

    // Nothing recovered AND nothing written: the call really is a dead end, and the
    // Zap should still hear about it the way it always has.
    if (!healedKey && attached.backfill === "already_present") {
      console.warn(
        `welcome-call orphan-match: ${callId} could not be healed (${healed.reason}) ` +
          `and its result was already logged on ${sfRecordId} — nothing to do.`
      );
      return {
        status: 404,
        body: {
          error: "recording_not_found",
          code: "RECORDING_NOT_FOUND",
          message: `No orphan recording for call_id ${callId}, and it could not be recovered.`,
          holdingKey,
          healAttempted: true,
          healReason: healed.reason ?? null,
        },
      };
    }

    console.log(
      `welcome-call orphan-match: ${callId} -> ${sfRecordId} repaired ` +
        `(healed=${healedKey ?? healed.reason}, backfill=${attached.backfill}, ` +
        `correction=${correction})`
    );
    return {
      status: 200,
      body: {
        already_matched: false,
        healed: Boolean(healedKey),
        key: healedKey,
        recordId: sfRecordId,
        callId,
        sizeBytes: healed.ok ? (healed.size ?? null) : null,
        metadata: healed.ok ? healed.metadata : "not_applicable",
        log: attached.log,
        backfill: attached.backfill,
        welcomeCallStatus: attached.status,
        correction,
        healReason: healedKey ? null : (healed.reason ?? null),
      },
    };
  }

  // ---- Promote -------------------------------------------------------------
  // The date comes from the HOLDING OBJECT's LastModified, not from now(): the sweep
  // may run days after the call, and a file named for the sweep date would misdate the
  // conversation it contains.
  const recordedAt = holding.LastModified ? new Date(holding.LastModified) : now;
  const destKey = matchedRecordingKey(sfRecordId, phoenixDate(recordedAt), callId);

  await s3.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      Key: destKey,
      CopySource: encodeCopySource(S3_BUCKET, holdingKey),
      MetadataDirective: "COPY",
    })
  );

  // Confirm the copy before anything names the key OR deletes the source. The log
  // line below is permanent and the delete below is not reversible, so both hang on
  // this answer rather than on the copy call having returned.
  const copyConfirmed = await objectExists(destKey);
  if (!copyConfirmed) {
    console.error(
      `welcome-call orphan-match: copied ${holdingKey} -> ${destKey} but the ` +
        `destination could not be confirmed — keeping the holding object and ` +
        `writing the result without a recording key.`
    );
  }

  const metadata = await registerRecordingMetadata({
    key: destKey,
    fileName: destKey.slice(destKey.lastIndexOf("/") + 1),
    tenantId,
    sfRecordId,
    size: holding.ContentLength ?? null,
    description: `Retell call ${callId} (rep-form, matched)`,
  });

  // Backfill BEFORE the holding object is deleted: if the write fails, the holding
  // object survives and the Zap's retry re-runs the whole thing.
  const attached = await recordMatchOnSalesforce({
    record,
    schema,
    callId,
    now,
    recordingKey: copyConfirmed ? destKey : null,
  });

  // Delete the holding object LAST, and only after the copy is confirmed. If anything
  // above threw, the holding object survives and the Zap can simply call again.
  //
  // A failed delete is NOT a failed match: the bytes are attached and registered. It
  // leaves a duplicate in the holding prefix, which a later retry cleans up (the retry
  // finds the destination, reports already_matched, and re-attempts nothing harmful).
  let holdingDeleted = false;
  try {
    // An unconfirmed copy keeps its source. The duplicate is free to clean up later;
    // the bytes are not.
    if (!copyConfirmed) throw new Error("destination unconfirmed");
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: holdingKey }));
    holdingDeleted = true;
  } catch (e) {
    console.error(
      `welcome-call orphan-match: copied ${holdingKey} -> ${destKey} but could not ` +
        `delete the holding object: ${e?.message || String(e)}`
    );
  }

  console.log(
    `welcome-call orphan-match: ${callId} -> ${sfRecordId} at ${destKey} ` +
      `(metadata=${metadata}, backfill=${attached.backfill}, ` +
      `status=${attached.status ?? "unchanged"}, holdingDeleted=${holdingDeleted})`
  );

  return {
    status: 200,
    body: {
      already_matched: false,
      key: copyConfirmed ? destKey : null,
      recordId: sfRecordId,
      callId,
      sizeBytes: holding.ContentLength ?? null,
      metadata,
      log: attached.log,
      backfill: attached.backfill,
      welcomeCallStatus: attached.status,
      holdingDeleted,
    },
  };
}
