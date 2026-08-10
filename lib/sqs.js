// lib/sqs.js — minimal SQS send helper for the doorbell → worker split.
//
// Kept deliberately thin: the doorbell Lambdas that use this run under a hard
// response deadline (Aurora gives us 10 seconds), so the only work here is one
// SendMessage call. The client is constructed lazily so importing this module is
// free for Lambdas that never enqueue.
//
// Value-safety: never logs message bodies (they can carry business ids).

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const REGION = process.env.AWS_REGION || "us-west-1";

let _client = null;
function client() {
  if (!_client) _client = new SQSClient({ region: REGION });
  return _client;
}

/** Test seam: swap in a fake client. Pass null to restore the real one. */
export function __setSqsClient(fake) {
  _client = fake;
}

/**
 * Send one JSON message to a queue.
 *
 * @param {string} queueUrl
 * @param {object} messageBody - serialized to JSON
 * @param {object} [opts]
 * @param {string} [opts.groupId] - MessageGroupId (FIFO queues only)
 * @param {string} [opts.dedupeId] - MessageDeduplicationId (FIFO queues only)
 * @returns {Promise<{ messageId: string }>}
 * @throws on any SDK error — the caller decides what that means (for a webhook
 *         doorbell it must become a 5xx so the sender retries).
 */
export async function sendMessage(queueUrl, messageBody, opts = {}) {
  if (!queueUrl) throw new Error("sendMessage: queueUrl is required.");
  const res = await client().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(messageBody),
      ...(opts.groupId ? { MessageGroupId: opts.groupId } : {}),
      ...(opts.dedupeId ? { MessageDeduplicationId: opts.dedupeId } : {}),
    })
  );
  return { messageId: res.MessageId };
}

/**
 * Parse the records of an SQS-triggered Lambda event into { messageId, body }.
 * A record whose body isn't JSON yields body: null rather than throwing, so one
 * malformed message can't take down the whole batch before it's even inspected.
 */
export function parseSqsRecords(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  return records.map((r) => {
    let body = null;
    try {
      body = typeof r.body === "string" ? JSON.parse(r.body) : r.body ?? null;
    } catch {
      /* malformed — surfaced as null */
    }
    return { messageId: r.messageId, receiptHandle: r.receiptHandle, body, raw: r.body };
  });
}
