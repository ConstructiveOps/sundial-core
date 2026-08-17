// sundial-welcome-call — the Welcome Call backend.
//
// ONE Lambda, TWO entry points, told apart by the SHAPE of the event:
//
//   1. PLATFORM EVENT (no HTTP method on the event) — `Sundial_Welcome_Call_Request__e`
//      relayed through Salesforce Event Relay -> Amazon EventBridge. Carries
//      Customer_Id__c. Reads the customer FRESH from Salesforce, applies the
//      eligibility guard, and places the call through Retell. See placeCall.js.
//
//   2. HTTP (POST /webhooks/retell) — Retell's lifecycle webhook. Forwards every
//      analyzed call to the Zapier billing ledger, then writes the verification
//      result back to Salesforce. See webhook.js.
//
// WHY SHAPE AND NOT A FLAG: the relay is Tim's to configure and its exact envelope
// (EventBridge vs SQS-wrapped) is not settled — the same ambiguity sundial-budget
// handles. An HTTP event always carries requestContext.http.method or httpMethod;
// nothing else does. That test is stable across every relay variant.
//
// There is NO portal UI for this feature and NO portal-authenticated route. The only
// HTTP surface is the webhook, and its only gate is the x-retell-signature HMAC — no
// Supabase JWT, no API Gateway authorizer (see webhook.js for why).

import { getConfig } from "./config.js";
import { extractCustomerIds, placeWelcomeCall } from "./placeCall.js";
import {
  EVENT_ANALYZED,
  SIGNATURE_HEADER,
  isAckOnlyEvent,
  processCallAnalyzed,
  verifySignature,
} from "./webhook.js";

// Retell is a server, not a browser, so CORS is not required. A small permissive set
// is sent so nothing downstream chokes; no credentials are echoed.
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Retell-Signature",
};

function jsonResponse(statusCode, bodyObj) {
  return { statusCode, headers: BASE_HEADERS, body: JSON.stringify(bodyObj) };
}

function normalizeHeaders(rawHeaders) {
  const out = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) out[String(k).toLowerCase()] = v;
  }
  return out;
}

/**
 * Recover the RAW request body exactly as Retell sent it. The signature is an HMAC
 * over those bytes, so this must not re-serialize anything: base64-decode when API
 * Gateway flags it, otherwise pass the string through untouched.
 *
 * A body delivered as an already-parsed object (direct invoke, tests) has no
 * recoverable raw form; it is re-serialized and will not verify, which is correct —
 * an unsigned invoke should not reach the writeback.
 */
function rawBodyOf(event) {
  const body = event?.body;
  if (body == null) return "";
  if (typeof body === "object") return JSON.stringify(body);
  if (event?.isBase64Encoded) {
    try {
      return Buffer.from(body, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return String(body);
}

// --- HTTP entry point -------------------------------------------------------
async function handleHttp(event, method) {
  if (method === "OPTIONS") return { statusCode: 204, headers: BASE_HEADERS, body: "" };
  if (method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const headers = normalizeHeaders(event?.headers);
  const rawBody = rawBodyOf(event);

  // --- AUTH GATE: the only protection on a public endpoint ------------------
  const cfg = await getConfig();
  if (!cfg.retellWebhookSecret) {
    // Fail CLOSED. An unset secret must never mean "accept everything" — that would
    // let anyone set a customer's verification status.
    console.error(
      "welcome-call webhook: RETELL_WEBHOOK_SECRET is not configured — rejecting. " +
        "Set it in the sundial/retell/api secret (or the env var) before going live."
    );
    return jsonResponse(401, { error: "unauthorized" });
  }
  if (!verifySignature(rawBody, headers[SIGNATURE_HEADER], cfg.retellWebhookSecret)) {
    // Never log the expected or received signature — only that the gate rejected.
    console.warn(`welcome-call webhook rejected: missing or invalid ${SIGNATURE_HEADER}.`);
    return jsonResponse(401, { error: "unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable: acked, because retrying will produce the same bytes.
    console.warn("welcome-call webhook: signed body was not JSON — acking.");
    return jsonResponse(200, { received: true, ignored: "unparseable_body" });
  }

  const eventName = String(payload?.event ?? "").trim();

  if (isAckOnlyEvent(eventName)) {
    // call_started / call_ended carry no analysis. Acked so Retell stops, and NOT
    // forwarded — the ledger records analyzed calls, one row per call.
    return jsonResponse(200, { received: true, ignored: eventName });
  }
  if (eventName !== EVENT_ANALYZED) {
    console.warn(`welcome-call webhook: unrecognized event "${eventName}" — acking.`);
    return jsonResponse(200, { received: true, ignored: eventName || "missing_event" });
  }

  const result = await processCallAnalyzed(payload, rawBody, cfg);
  return jsonResponse(result.status, result.body);
}

// --- Platform-event entry point --------------------------------------------
async function handlePlatformEvent(event) {
  const ids = extractCustomerIds(event);
  if (ids.length === 0) {
    console.warn(
      "welcome-call: platform-event invocation carried no Customer_Id__c — nothing to do."
    );
    return { processed: 0, results: [] };
  }

  // Sequential on purpose. A relay batch is small, each iteration makes several
  // Salesforce calls, and this account's Lambda concurrency quota is tight (see the
  // G2 note in docs/api-endpoints.md) — fanning out buys nothing and risks throttles.
  const results = [];
  let failures = 0;
  for (const id of ids) {
    try {
      results.push(await placeWelcomeCall(id));
    } catch (e) {
      failures++;
      console.error(`welcome-call: failed to place call for ${id}:`, e?.message || String(e));
      results.push({ recordId: id, status: "error", error: e?.message || String(e) });
    }
  }

  // Throwing on any failure is what makes the relay retry. Records that succeeded are
  // protected from a duplicate dial by their new "Calling" status.
  if (failures > 0) {
    const err = new Error(`welcome-call: ${failures} of ${ids.length} call attempts failed`);
    err.results = results;
    throw err;
  }
  return { processed: results.length, results };
}

// --- handler ----------------------------------------------------------------
export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || null;

  try {
    if (method) return await handleHttp(event, method);
    return await handlePlatformEvent(event);
  } catch (err) {
    if (method) {
      console.error("welcome-call unexpected error:", err?.message || String(err));
      return jsonResponse(500, { error: "server_error" });
    }
    throw err; // platform-event path: let the relay see the failure and retry
  }
};
