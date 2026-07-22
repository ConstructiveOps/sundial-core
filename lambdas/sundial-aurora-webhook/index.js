// sundial-aurora-webhook — PUBLIC webhook receiver ("doorbell") for Aurora Solar.
//
// Aurora calls this endpoint (via GET) when an agreement's status changes:
//   GET /webhooks/aurora/agreement-status
//       ?project_id=<PROJECT_ID>&agreement_id=<AGREEMENT_ID>&status=<STATUS>
//   + custom header  X-Aurora-Webhook-Token: <shared secret>
//
// THIS BUILD IS THE RECEIVER ONLY. It validates the shared-secret header, parses
// the query params, logs the event, and returns a fast 200 ack. It does NOT call
// Aurora back and does NOT touch Salesforce — the callback/data-pull is the next
// build. Webhooks expect a quick 200, so this path is intentionally minimal.
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

// The Aurora API secret now also carries the webhook shared secret.
const AURORA_SECRET_NAME = "sundial/aurora/api";

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

// --- Webhook token (validated + cached in module scope) --------------------
let webhookTokenCache = null;
async function getWebhookToken() {
  if (webhookTokenCache) return webhookTokenCache;
  const secret = await getSecret(AURORA_SECRET_NAME);
  const token = secret?.webhook_token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(
      `Secret "${AURORA_SECRET_NAME}" is missing a non-empty webhook_token.`
    );
  }
  webhookTokenCache = token;
  return webhookTokenCache;
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

    // --- Parse query params (tolerate missing ones) ------------------------
    const qs = event?.queryStringParameters || {};
    const project_id = qs.project_id ?? null;
    const agreement_id = qs.agreement_id ?? null;
    const status = qs.status ?? null;

    // --- v1 ACTION: log and ack fast ---------------------------------------
    // Doorbell only: record the event to CloudWatch and return immediately. No
    // Aurora callback, no Salesforce write — that is the NEXT build. Logging what
    // is present (nulls included) makes a missing param visible without failing.
    console.log(
      "aurora-webhook agreement-status received:",
      JSON.stringify({ project_id, agreement_id, status })
    );

    return jsonResponse(200, {
      received: true,
      project_id,
      agreement_id,
      status,
    });
  } catch (err) {
    console.error(
      "aurora-webhook unexpected error:",
      err?.message || String(err)
    );
    return jsonResponse(500, { error: "server_error" });
  }
};
