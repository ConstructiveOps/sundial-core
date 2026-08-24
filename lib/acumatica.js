// Shared Acumatica ERP access for Sundial Lambda functions.
//
// Implements the OAuth 2.0 Resource Owner Password Credentials (ROPC) flow
// against the Acumatica contract-based REST API, caches the access token in
// module scope for warm-container reuse, and exposes a thin entity PUT helper.
//
// Every value (base_url, client_id, client_secret, username, password) is pulled
// from the `sundial/acumatica/connected-app` secret at runtime via lib/secrets.js.
// Nothing sensitive is hardcoded, logged, or attached to thrown errors here.
//
// This mirrors the shape of lib/salesforce.js (config from a secret, module-scope
// token cache, refresh-and-retry on 401) so the two integrations read alike.

import { getSecret } from "./secrets.js";

// ⚠️ A POINTER, NOT A TENANT (D-058). This one secret name holds the SANDBOX (BizRun)
// through the rework and is repointed at LIVE at the end of the release window — which is
// the feature: nothing here, in any Lambda env var, or in any runbook needs editing at
// cutover. The cost is that no comment or doc may say which tenant it "is", because that
// sentence goes stale silently. To find out, read the credential: Acumatica suffixes the
// ROPC client_id with the tenant the grant is scoped to, so it cannot disagree with
// reality. `BizRun Tenant` is the sandbox.
export const ACUMATICA_SECRET_NAME = "sundial/acumatica/connected-app";

// Contract-based REST endpoint name + version. Entity URLs are:
//   {base_url}/entity/Default/25.200.001/{Entity}
const ENDPOINT_NAME = "Default";
const ENDPOINT_VERSION = "25.200.001";

// Token lifetime handling. The ROPC response usually includes expires_in; if it
// doesn't we assume a conservative TTL and ALSO refresh on any 401 (the real net).
const TOKEN_SKEW_MS = 60 * 1000; // refresh ~1 min before expiry
const ASSUMED_TTL_MS = 3600 * 1000; // 1 hour if expires_in absent

// ---------------------------------------------------------------------------
// Config (validated + cached in module scope)
// ---------------------------------------------------------------------------
let configCache = null;
async function getConfig() {
  if (configCache) return configCache;
  const s = await getSecret(ACUMATICA_SECRET_NAME);
  const required = ["base_url", "client_id", "client_secret", "username", "password"];
  const missing = required.filter(
    (k) => s?.[k] == null || String(s[k]).trim() === ""
  );
  if (missing.length > 0) {
    throw new Error(
      `Secret "${ACUMATICA_SECRET_NAME}" is missing field(s): ${missing.join(", ")}.`
    );
  }
  configCache = {
    baseUrl: String(s.base_url).replace(/\/+$/, ""), // trim trailing slash
    clientId: String(s.client_id), // NOTE: may contain a space (e.g. "...@BizRun Tenant")
    clientSecret: String(s.client_secret),
    username: String(s.username),
    password: String(s.password),
  };
  return configCache;
}

// ---------------------------------------------------------------------------
// Token cache (survives warm invocations)
// ---------------------------------------------------------------------------
let tokenCache = null; // { accessToken, expiresAt } | null

// Mint a new access token via the ROPC grant. URLSearchParams handles form
// encoding, so the space inside client_id is encoded correctly. Refresh tokens
// are intentionally NOT persisted — we re-run the password grant when needed.
async function requestNewToken() {
  const cfg = await getConfig();

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    username: cfg.username,
    password: cfg.password,
    scope: "api",
  });

  const resp = await fetch(`${cfg.baseUrl}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) {
    // Surface only the status + short OAuth error code (e.g. "invalid_grant") —
    // never the request body (which carried credentials).
    let code = null;
    try {
      code = JSON.parse(text)?.error ?? null;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(
      `Acumatica token request failed (${resp.status})${code ? `: ${code}` : ""}`
    );
    err.acuStatus = resp.status;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Acumatica token response was not JSON.");
  }
  if (!data.access_token) {
    throw new Error("Acumatica token response missing access_token.");
  }

  const ttlMs = data.expires_in ? Number(data.expires_in) * 1000 : ASSUMED_TTL_MS;
  tokenCache = { accessToken: data.access_token, expiresAt: Date.now() + ttlMs };
  return tokenCache;
}

/**
 * Get a valid Acumatica access token, reusing the module-scope cache while it is
 * comfortably valid, otherwise minting a fresh one.
 *
 * @param {{ forceRefresh?: boolean }} [opts]
 * @returns {Promise<string>} the bearer access token
 */
export async function getAcumaticaToken(opts = {}) {
  const { forceRefresh = false } = opts;
  const stillFresh =
    tokenCache &&
    !forceRefresh &&
    Date.now() < tokenCache.expiresAt - TOKEN_SKEW_MS;
  if (stillFresh) return tokenCache.accessToken;
  const fresh = await requestNewToken();
  return fresh.accessToken;
}

// Build a fully-encoded entity URL. Query params (if any) are encoded via
// URLSearchParams — never string-concatenated — so values like $filter/$expand
// are always transmitted clean (PowerShell mangled these during hand-testing).
function buildEntityUrl(baseUrl, entity, query) {
  let url = `${baseUrl}/entity/${ENDPOINT_NAME}/${ENDPOINT_VERSION}/${entity}`;
  if (query && Object.keys(query).length > 0) {
    url += `?${new URLSearchParams(query).toString()}`;
  }
  return url;
}

/**
 * PUT a record to an Acumatica entity (create-or-update per contract-based REST).
 * Refreshes the token once and retries on a 401.
 *
 * @param {string} entity - e.g. "Customer" or "Project"
 * @param {object} bodyObj - the Acumatica entity body ({ Field: { value } } shape)
 * @param {object} [query] - optional query params (encoded via URLSearchParams)
 * @returns {Promise<{ ok: boolean, status: number, data: object|null, text: string }>}
 */
export async function putAcumaticaEntity(entity, bodyObj, query) {
  const cfg = await getConfig();

  async function run(forceRefresh) {
    const token = await getAcumaticaToken({ forceRefresh });
    return fetch(buildEntityUrl(cfg.baseUrl, entity, query), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(bodyObj),
    });
  }

  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. HTML error page) -> leave data null, keep text */
  }
  return { ok: resp.ok, status: resp.status, data, text };
}

/**
 * GET an Acumatica entity, typically with an OData `$filter` (and optional
 * `$expand`/`$select`). Query params are encoded via URLSearchParams so spaces
 * become %20 and quotes %27 — the correct encoding for `$filter=ProjectID eq 'X'`.
 * (Raw PowerShell-style strings mangle these; Node must build clean encoded URLs.)
 * Refreshes the token once and retries on a 401.
 *
 * @param {string} entity - e.g. "ProjectBudget"
 * @param {object} [query] - e.g. { "$filter": "ProjectID eq 'CT000123'" }
 * @returns {Promise<{ ok: boolean, status: number, data: any, text: string }>}
 *   data is the parsed array/object body on success.
 */
export async function getAcumaticaEntity(entity, query) {
  const cfg = await getConfig();

  async function run(forceRefresh) {
    const token = await getAcumaticaToken({ forceRefresh });
    return fetch(buildEntityUrl(cfg.baseUrl, entity, query), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  }

  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON -> leave data null, keep text */
  }
  return { ok: resp.ok, status: resp.status, data, text };
}

// ---------------------------------------------------------------------------
// Phone formatting — Acumatica enforces an INPUT MASK server-side
// ---------------------------------------------------------------------------
/**
 * Format a phone number for Acumatica's `(999) 999-9999` input mask.
 *
 * WHY THIS EXISTS. Acumatica validates phone fields against a mask and rejects the
 * whole entity when it does not match — a 422 with:
 *
 *   "The provided value '623 703-2778' does not match the required input mask
 *    '(999) 999-9999'."
 *
 * That killed a real production Create Project for a customer whose Salesforce phone
 * was `623 703-2778`. Salesforce imposes no phone format, so ANY customer whose number
 * is not already in Acumatica's exact shape fails the same way. This is not a sandbox
 * artifact: the mask is identical in production.
 *
 * EXTENSIONS ARE SEPARATED, NOT SILENTLY DISCARDED. `Phone1` has no extension slot, so
 * an extension cannot be sent — but losing one without saying so would quietly damage
 * the ops record. It is returned so the caller can surface it.
 *
 * RETURNS RATHER THAN THROWS. A phone is not worth failing a customer create over; the
 * caller omits it and warns, the same way an unmatched tax zone is handled. Callers
 * must not invent a number — `phone: null` means "send nothing".
 *
 * @param {unknown} raw
 * @returns {{ phone: string|null, extension: string|null, reason: string|null }}
 *   phone     - masked value, or null when nothing usable was found
 *   extension - digits stripped off the end, when present
 *   reason    - why `phone` is null, when the input was non-empty but unusable
 */
export function normalizeAcumaticaPhone(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { phone: null, extension: null, reason: null };

  // Pull a trailing extension off FIRST — otherwise its digits merge into the number
  // and a perfectly good phone reads as "13 digits, unusable".
  let extension = null;
  const extMatch = text.match(/(?:\bx|\bext\.?|\bextension\b|#)\s*(\d{1,6})\s*$/i);
  const base = extMatch ? text.slice(0, extMatch.index) : text;
  if (extMatch) extension = extMatch[1];

  let digits = base.replace(/\D/g, "");

  // Strip a NANP country code so +1 / 1- prefixed numbers are accepted rather than
  // read as 11 digits and rejected.
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);

  if (digits.length !== 10) {
    return {
      phone: null,
      extension,
      reason:
        digits.length === 0
          ? "no digits found"
          : `expected 10 digits, found ${digits.length}`,
    };
  }

  return {
    phone: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`,
    extension,
    reason: null,
  };
}
