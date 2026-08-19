// Configuration + credential resolution for sundial-comment-notify.
//
// Mirrors sundial-welcome-call/config.js, including its precedence rule:
//
//   CREDENTIALS resolve SECRETS-MANAGER-FIRST, env var second. That is what makes
//   ROTATION work — change the secret and every warm container picks it up within the
//   TTL below, with no redeploy. If the env var won, a stale value baked into the
//   function config would silently shadow the rotated secret (the failure mode D-045
//   exists to bound). docs/api-endpoints.md is also explicit that credentials never
//   live in a Lambda env var.
//
//   CONFIG (PORTAL_BASE_URL) resolves ENV-FIRST. It is an address, not a credential,
//   and the env var is the per-tenant knob.
//
// Both sources are accepted for both values, so nothing breaks if an operator sets one
// in the "other" place.
//
// Value-safety: no value from this module is ever logged.

import { getSecret } from "../../lib/secrets.js";

export const COMMENT_NOTIFY_SECRET_NAME = "sundial/comment-notify";

// Portal origin for the deep link in the email. Same variable name as
// sundial-user-admin uses for invite links (D-053), and the same in-code default, so a
// lost env var degrades to the working domain rather than a dead one.
export const DEFAULT_PORTAL_BASE_URL = "https://sundial.harmonelectric.net";

// Field names accepted inside the secret, in priority order — the candidate-list
// approach from lib/salesforce.js, so the secret's exact naming need not be guessed at
// deploy time.
const SECRET_FIELD_CANDIDATES = {
  COMMENT_NOTIFY_SECRET: [
    "comment_notify_secret",
    "commentNotifySecret",
    "webhook_secret",
    "secret",
  ],
  PORTAL_BASE_URL: ["portal_base_url", "portalBaseUrl"],
};

// Same reasoning as the Aurora webhook token cache (D-045): caching for the life of a
// warm container means a rotated credential keeps working with the OLD value until the
// container recycles. Five minutes bounds that.
const SECRET_TTL_MS = 5 * 60 * 1000;
let secretCache = null; // { value, fetchedAt }

/**
 * Read the secret, tolerating its absence — a deployment that puts everything in env
 * vars is valid, so a missing secret resolves to {} rather than throwing. A FAILED read
 * is not cached, so the next invocation retries it.
 */
async function loadSecret() {
  if (secretCache && Date.now() - secretCache.fetchedAt < SECRET_TTL_MS) {
    return secretCache.value;
  }
  let value = {};
  try {
    const s = await getSecret(COMMENT_NOTIFY_SECRET_NAME);
    if (s && typeof s === "object") value = s;
  } catch {
    return {}; // not created yet (or unreadable) — env vars may supply everything
  }
  secretCache = { value, fetchedAt: Date.now() };
  return value;
}

function fromEnv(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function fromSecret(secret, name) {
  for (const field of SECRET_FIELD_CANDIDATES[name] || []) {
    const v = secret?.[field];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * @returns {Promise<{ commentNotifySecret: string|null, portalBaseUrl: string }>}
 *   commentNotifySecret is null when unset — the caller FAILS CLOSED on that.
 */
export async function getConfig() {
  const secret = await loadSecret();
  return {
    commentNotifySecret:
      fromSecret(secret, "COMMENT_NOTIFY_SECRET") ?? fromEnv("COMMENT_NOTIFY_SECRET"),
    portalBaseUrl: (
      fromEnv("PORTAL_BASE_URL") ??
      fromSecret(secret, "PORTAL_BASE_URL") ??
      DEFAULT_PORTAL_BASE_URL
    ).replace(/\/+$/, ""), // trim trailing slash so link building can't double up
  };
}

/** Test/maintenance helper — drop the cached secret so the next read refetches. */
export function clearConfigCache() {
  secretCache = null;
}
