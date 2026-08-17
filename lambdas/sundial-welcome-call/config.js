// Configuration + credential resolution for sundial-welcome-call.
//
// TWO CLASSES OF SETTING, TWO PRECEDENCE ORDERS — deliberately:
//
//   CREDENTIALS (RETELL_API_KEY, RETELL_WEBHOOK_SECRET) resolve
//   SECRETS-MANAGER-FIRST, env var second. docs/api-endpoints.md is explicit that
//   credentials belong in Secrets Manager and never in a Lambda env var, and
//   secret-first is what makes ROTATION work: change the secret, and every warm
//   container picks it up within the TTL below with no redeploy. If the env var won,
//   a stale value baked into the function config would silently shadow the rotated
//   secret — the exact failure the Aurora webhook token TTL exists to prevent (D-045).
//
//   CONFIG (RETELL_FROM_NUMBER, RETELL_AGENT_ID, ZAPIER_RESULTS_HOOK_URL) resolves
//   ENV-FIRST, secret second. These are addresses, not credentials; the env var is
//   the documented place for them and is the per-tenant knob.
//
// Either way BOTH sources are accepted for all five, so nothing breaks if an
// operator sets a value in the "other" place.
//
// Value-safety: no value from this module is ever logged. The only thing callers may
// log is WHICH name was missing.

import { getSecret } from "../../lib/secrets.js";

export const RETELL_SECRET_NAME = "sundial/retell/api";

// Field names accepted inside the secret, per logical value, in priority order.
// Mirrors the candidate-list approach in lib/salesforce.js so the secret's exact
// field naming doesn't have to be guessed at deploy time.
const SECRET_FIELD_CANDIDATES = {
  RETELL_API_KEY: ["api_key", "apiKey", "retell_api_key", "key"],
  RETELL_WEBHOOK_SECRET: ["webhook_secret", "webhookSecret", "signing_secret", "webhook_token"],
  RETELL_FROM_NUMBER: ["from_number", "fromNumber"],
  RETELL_AGENT_ID: ["agent_id", "agentId", "override_agent_id"],
  ZAPIER_RESULTS_HOOK_URL: ["zapier_results_hook_url", "zapier_hook_url", "results_hook_url"],
};

// Same reasoning as the Aurora webhook token cache (D-045): caching for the life of
// a warm container makes a rotated credential keep working with the old value until
// the container recycles. Five minutes bounds that.
const SECRET_TTL_MS = 5 * 60 * 1000;
let secretCache = null; // { value, fetchedAt }

/**
 * Read the Retell secret, tolerating its absence. A missing secret is NOT an error
 * here — a deployment that puts everything in env vars is valid — so this resolves
 * to {} rather than throwing. A failed read is not cached, so the next invocation
 * retries it.
 */
async function loadSecret() {
  if (secretCache && Date.now() - secretCache.fetchedAt < SECRET_TTL_MS) {
    return secretCache.value;
  }
  let value = {};
  try {
    const s = await getSecret(RETELL_SECRET_NAME);
    if (s && typeof s === "object") value = s;
  } catch {
    // Secret not created yet (or unreadable) — env vars may still supply everything.
    return {};
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
 * Resolve every setting the Lambda can use. Missing values come back as null so the
 * caller decides what is fatal for ITS path — the place-call path cannot run without
 * an API key, but the webhook path does not need one.
 *
 * @returns {Promise<{
 *   retellApiKey: string|null, retellWebhookSecret: string|null,
 *   retellFromNumber: string|null, retellAgentId: string|null,
 *   zapierResultsHookUrl: string|null
 * }>}
 */
export async function getConfig() {
  const secret = await loadSecret();
  const credential = (name) => fromSecret(secret, name) ?? fromEnv(name); // secret wins
  const setting = (name) => fromEnv(name) ?? fromSecret(secret, name); // env wins

  return {
    retellApiKey: credential("RETELL_API_KEY"),
    retellWebhookSecret: credential("RETELL_WEBHOOK_SECRET"),
    retellFromNumber: setting("RETELL_FROM_NUMBER"),
    retellAgentId: setting("RETELL_AGENT_ID"),
    zapierResultsHookUrl: setting("ZAPIER_RESULTS_HOOK_URL"),
  };
}

/** Test/maintenance helper — drop the cached secret so the next read refetches. */
export function clearConfigCache() {
  secretCache = null;
}
