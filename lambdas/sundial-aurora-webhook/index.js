// sundial-aurora-webhook — PUBLIC webhook receiver ("doorbell") for Aurora Solar.
//
// Aurora calls this endpoint (via GET) on every agreement status change:
//   GET /webhooks/aurora/agreement-status
//       ?project_id=<PROJECT_ID>&design_id=<DESIGN_ID>&agreement_id=<AGREEMENT_ID>
//       &financing_id=<FINANCING_ID>&status=<STATUS>
//   + custom header  X-Aurora-Webhook-Token: <shared secret>
//
// DOORBELL ONLY — it authenticates, validates minimally, ENQUEUES to SQS, and
// returns. All real work (Aurora retrievals, Salesforce write-back, the signed PDF,
// the notification email) happens in the sundial-aurora-inbound worker.
//
// WHY THE SPLIT: Aurora counts the delivery as FAILED if we don't respond within
// 10 SECONDS, and a failed delivery enters a retry ladder (30s, 5m, 30m, 3h, 20h)
// that auto-disables the subscription after ~48h of failures. Retrieving a design
// summary + financing + proposal + generating and downloading a signed PDF cannot
// fit in that budget. So this handler does no network I/O beyond one SendMessage.
// Nothing may be added here that talks to Salesforce or Aurora.
//
// ENQUEUE FAILURE IS A DELIBERATE 5xx: if we cannot hand the event to the queue, we
// have not accepted it, and Aurora's retry ladder is exactly the recovery we want.
// Returning 200 there would silently drop a signed contract.
//
// WHY THIS ENDPOINT IS PUBLIC AND DOES NOT USE resolveIdentity
// ------------------------------------------------------------
// Every other Sundial Lambda is called by a signed-in portal USER and is gated by
// resolveIdentity (a verified Supabase token -> Sundial_User__c -> tenant). This
// endpoint is different: the caller is AURORA — a machine, with NO Sundial user
// and NO Supabase token. resolveIdentity has nothing to verify here and MUST NOT
// be used. The SOLE protection is the shared secret Aurora sends in the
// X-Aurora-Webhook-Token header, checked below with a constant-time compare.
// Because that header is the only gate, it must be correct: a missing or wrong
// token is rejected before anything else happens.
//
// Value-safety: never logs the expected token, the received token, secrets, or
// key material. Only the (non-sensitive) business params are logged.

import crypto from "crypto";
import { getSecret } from "../../lib/secrets.js";
import { sendMessage } from "../../lib/sqs.js";

// The Aurora API secret carries the webhook shared secret as `webhook_token`.
// A DEDICATED secret is also accepted so the token can be rotated/separated from
// the API credentials later without a code change; the dedicated one wins when
// present. (The deployed doorbell has always read the api secret — keeping that
// working is why this is a fallback chain rather than a swap.)
const AURORA_SECRET_NAME = "sundial/aurora/api";
const AURORA_WEBHOOK_SECRET_NAME = "sundial/aurora/webhook";

// The queue the worker (sundial-aurora-inbound) consumes.
const QUEUE_URL_ENV = "AURORA_INBOUND_QUEUE_URL";

// Statuses Aurora can send (hyphenated on the webhook; the agreement object uses
// underscores). Anything else is still enqueued — the worker decides — but it is
// logged so an unexpected value is visible rather than silent.
const KNOWN_STATUSES = new Set([
  "sent",
  "viewed",
  "signed",
  "cancel-pending",
  "cancel_pending",
  "canceled",
  "declined",
  "error",
]);

// The custom auth header Aurora is configured to send on the subscription.
// Compared case-insensitively (API Gateway may lowercase header keys).
const WEBHOOK_TOKEN_HEADER = "x-aurora-webhook-token";

// --- Simple, non-credential response headers -------------------------------
// Aurora is a server, not a browser, so CORS is not strictly required. We send a
// small permissive set so nothing downstream breaks, and we deliberately do NOT
// echo credentials or an Access-Control-Allow-Credentials header.
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "X-Aurora-Webhook-Token, Content-Type",
};

function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: BASE_HEADERS,
    body: JSON.stringify(bodyObj),
  };
}

// Lowercase all header keys so lookups are case-insensitive regardless of how the
// gateway delivers them.
function normalizeHeaders(rawHeaders) {
  const out = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) out[k.toLowerCase()] = v;
  }
  return out;
}

// --- Webhook token (validated + cached in module scope, with TTL) ----------
// Looks in the dedicated secret first, then the API secret. Either may hold it
// under `webhook_token` (or `token` in the dedicated one). A missing dedicated
// secret is NOT an error — it is the normal state today.
//
// TTL, for the same reason the describe cache has one (D-045): a token cached for
// the life of a warm container means ROTATING the shared secret silently keeps
// working with the old value until the container recycles — and, worse, starts
// 401-ing Aurora once Aurora is switched to the new one. Five minutes bounds the
// window without putting a Secrets Manager call on every delivery.
const TOKEN_TTL_MS = 5 * 60 * 1000;
let webhookTokenCache = null; // { token, fetchedAt }

async function getWebhookToken() {
  if (webhookTokenCache && Date.now() - webhookTokenCache.fetchedAt < TOKEN_TTL_MS) {
    return webhookTokenCache.token;
  }

  let dedicated = null;
  try {
    dedicated = await getSecret(AURORA_WEBHOOK_SECRET_NAME);
  } catch {
    /* not created yet — fall through to the API secret */
  }
  const fromDedicated = dedicated?.webhook_token ?? dedicated?.token;
  if (typeof fromDedicated === "string" && fromDedicated.trim() !== "") {
    webhookTokenCache = { token: fromDedicated, fetchedAt: Date.now() };
    return webhookTokenCache.token;
  }

  const secret = await getSecret(AURORA_SECRET_NAME);
  const token = secret?.webhook_token;
  if (typeof token !== "string" || token.trim() === "") {
    // Do NOT cache a failure — the next delivery should retry the lookup.
    throw new Error(
      `No webhook token: set "webhook_token" in "${AURORA_WEBHOOK_SECRET_NAME}" ` +
        `or "${AURORA_SECRET_NAME}".`
    );
  }
  webhookTokenCache = { token, fetchedAt: Date.now() };
  return webhookTokenCache.token;
}

// Constant-time string comparison that is also length-safe. crypto.timingSafeEqual
// throws if the two buffers differ in length, and comparing raw lengths first would
// leak the expected length. So we compare fixed-length SHA-256 digests of both
// values: the digests are always 32 bytes (no length leak, no throw), and only
// identical inputs produce identical digests. This keeps the token check free of
// early-exit timing signals.
function constantTimeEquals(a, b) {
  const ha = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const hb = crypto.createHash("sha256").update(String(b), "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

// --- handler ---------------------------------------------------------------
export const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "GET";

  // OPTIONS preflight: acknowledge quickly, no auth needed.
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: BASE_HEADERS, body: "" };
  }

  // Aurora calls via GET. Anything else is not how this webhook is invoked.
  if (method !== "GET") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  try {
    const headers = normalizeHeaders(event?.headers);

    // --- AUTH GATE: the ONLY protection for this public endpoint -----------
    // Read the shared-secret header (case-insensitive) and constant-time compare
    // it to webhook_token from the secret. Missing or mismatched -> 401, and
    // nothing else proceeds. We log a warning WITHOUT the expected/received token.
    const provided = headers[WEBHOOK_TOKEN_HEADER];
    let expected;
    try {
      expected = await getWebhookToken();
    } catch (e) {
      // Misconfigured secret — fail closed (never treat as authorized).
      console.error("aurora-webhook token config error:", e?.message || String(e));
      return jsonResponse(401, { error: "unauthorized" });
    }

    if (
      typeof provided !== "string" ||
      provided.length === 0 ||
      !constantTimeEquals(provided, expected)
    ) {
      // Do NOT log the expected or received token — only that the gate rejected.
      console.warn(
        "aurora-webhook rejected: missing or invalid X-Aurora-Webhook-Token."
      );
      return jsonResponse(401, { error: "unauthorized" });
    }

    // --- Parse the five subscription attributes ----------------------------
    // Accepted under snake_case or the bare UPPER names, so a url_template typo
    // in Aurora's console doesn't silently drop a parameter.
    const qs = event?.queryStringParameters || {};
    const pick = (...names) => {
      for (const n of names) {
        const v = qs[n];
        if (typeof v === "string" && v.trim() !== "") return v.trim();
      }
      return null;
    };
    const project_id = pick("project_id", "PROJECT_ID");
    const design_id = pick("design_id", "DESIGN_ID");
    const agreement_id = pick("agreement_id", "AGREEMENT_ID");
    // EMPTY IS MEANINGFUL: Aurora sends an empty FINANCING_ID when no financing
    // option was selected on the design. That is not an error — the worker skips
    // the financing retrieval entirely.
    const financing_id = pick("financing_id", "FINANCING_ID");
    const status = pick("status", "STATUS");

    // --- Minimal validation ------------------------------------------------
    // Only what we cannot act without. Deliberately NOT strict: a 4xx here would
    // burn Aurora's retry ladder on an event we are simply not going to process.
    const missing = [];
    if (!project_id) missing.push("project_id");
    if (!agreement_id) missing.push("agreement_id");
    if (!status) missing.push("status");
    if (missing.length > 0) {
      console.warn(
        `aurora-webhook rejected: missing required param(s) ${missing.join(", ")}.`
      );
      return jsonResponse(400, { error: "missing_params", missing });
    }
    if (!KNOWN_STATUSES.has(status.toLowerCase())) {
      // Enqueue anyway (the worker is the authority) but make it visible.
      console.warn(`aurora-webhook: unrecognized status "${status}" — enqueuing anyway.`);
    }
    if (!design_id && status.toLowerCase() === "signed") {
      // The signed path needs design_id for the design/proposal/financing reads.
      // Still enqueued: the worker reports it properly and dead-letters.
      console.error(
        `aurora-webhook: signed event for agreement ${agreement_id} has NO design_id.`
      );
    }

    // --- ENQUEUE and ack ----------------------------------------------------
    const queueUrl = process.env[QUEUE_URL_ENV];
    if (!queueUrl) {
      // Misconfiguration. 5xx ON PURPOSE: Aurora retries, and the event survives
      // until the env var is set, instead of being acked into a void.
      console.error(
        `aurora-webhook: ${QUEUE_URL_ENV} is not set — cannot enqueue; returning 500 so Aurora retries.`
      );
      return jsonResponse(500, { error: "queue_not_configured" });
    }

    const message = {
      source: "aurora.agreement_status_changed",
      project_id,
      design_id,
      agreement_id,
      financing_id, // may be null — meaningful, see above
      status,
      // Aurora sends no timestamp, and the agreement object carries no signed_at,
      // so RECEIPT TIME is our only signing timestamp. Stamped here, at the edge,
      // so a queue backlog or a worker retry can't drift it.
      received_at: new Date().toISOString(),
    };

    try {
      const { messageId } = await sendMessage(queueUrl, message);
      console.log(
        "aurora-webhook enqueued:",
        JSON.stringify({ project_id, agreement_id, status, messageId })
      );
      return jsonResponse(200, { received: true, queued: true, agreement_id, status });
    } catch (e) {
      // See the header note: a failed enqueue MUST be a 5xx.
      console.error(
        `aurora-webhook ENQUEUE FAILED for agreement ${agreement_id} (${status}): ` +
          `${e?.message || String(e)} — returning 500 so Aurora retries.`
      );
      return jsonResponse(500, { error: "enqueue_failed" });
    }
  } catch (err) {
    console.error(
      "aurora-webhook unexpected error:",
      err?.message || String(err)
    );
    return jsonResponse(500, { error: "server_error" });
  }
};
