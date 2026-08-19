// sundial-comment-notify — POST /webhooks/comment-mention
//
// Sends the "you were @-mentioned" email. Called by an AFTER INSERT trigger on
// `comment_mentions` via pg_net (sql/sundial_comment_mention_notify.sql), NOT by the
// browser and NOT by any portal user.
//
// WHY THE DATABASE CALLS US AND NOT THE CLIENT: comments are written straight from the
// browser under RLS — there is no server in that path at all, and harmon-crm's mention
// insert is explicitly best-effort. If the client also owned the notification, closing
// a tab would silently lose SOMEBODY ELSE'S alert, and neither party would ever know.
// Once the mention row is committed, the notification is the database's problem. See
// D-056.
//
// THE THIRD PUBLIC NON-JWT ROUTE, after the Aurora doorbell and the Retell webhook, and
// held to the same discipline:
//   - shared secret in a header (X-Sundial-Comment-Secret), nothing else
//   - constant-time compare via the shared lib/secure-compare.js helper
//   - FAIL CLOSED: an unreadable secret rejects everything rather than accepting it
// resolveIdentity is not used and must not be — the caller is Postgres, which has no
// Sundial user and no Supabase session.
//
// Value-safety: the secret is never logged, and neither is a comment body or a full
// recipient address (the rule stated in lib/email.js).

import { constantTimeEquals } from "../../lib/secure-compare.js";
import { getConfig } from "./config.js";
import { handleMention } from "./notify.js";

export const SECRET_HEADER = "x-sundial-comment-secret";

// Postgres is a server, not a browser, so CORS is not required. A small permissive set
// keeps anything downstream from choking; no credentials are echoed.
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sundial-Comment-Secret",
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

/** Body, decoded if API Gateway base64-flagged it, tolerant of a pre-parsed object. */
function parseBody(event) {
  let raw = event?.body;
  if (raw == null) return { ok: false };
  if (typeof raw === "object") return { ok: true, data: raw };
  if (event?.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return { ok: false };
    }
  }
  raw = String(raw).trim();
  if (raw === "") return { ok: false };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "POST";

  if (method === "OPTIONS") return { statusCode: 204, headers: BASE_HEADERS, body: "" };
  if (method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  try {
    const headers = normalizeHeaders(event?.headers);
    const cfg = await getConfig();

    // --- AUTH GATE: the only protection on a public endpoint -----------------
    // An unset secret must NEVER mean "accept everything" — this route emails comment
    // bodies to addresses derived from caller-supplied ids.
    if (!cfg.commentNotifySecret) {
      console.error(
        "comment-notify: COMMENT_NOTIFY_SECRET is not configured — rejecting. Set it in " +
          "the sundial/comment-notify secret (or the env var) before enabling the trigger."
      );
      return jsonResponse(401, { error: "unauthorized" });
    }
    const provided = headers[SECRET_HEADER];
    if (
      typeof provided !== "string" ||
      provided.length === 0 ||
      !constantTimeEquals(provided, cfg.commentNotifySecret)
    ) {
      // Never log the expected or received secret — only that the gate rejected.
      console.warn(`comment-notify rejected: missing or invalid ${SECRET_HEADER}.`);
      return jsonResponse(401, { error: "unauthorized" });
    }

    const body = parseBody(event);
    if (!body.ok) {
      return jsonResponse(400, { error: "invalid_body", code: "INVALID_BODY" });
    }

    const result = await handleMention(body.data, cfg);
    return jsonResponse(result.status, result.body);
  } catch (err) {
    console.error("comment-notify unexpected error:", err?.message || String(err));
    return jsonResponse(500, { error: "server_error" });
  }
};
