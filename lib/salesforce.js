// Shared Salesforce access for all Sundial Lambda functions.
//
// Implements the Connected App JWT bearer flow against the single Sundial
// Integration User, then exposes a thin SOQL query helper. Tokens are cached in
// module scope and reused across warm invocations until just before expiry, with
// an automatic refresh-and-retry on a 401.
//
// Every value (consumer key, integration username, private key, login URL) is
// pulled from the `sundial/salesforce/connected-app` secret at runtime via
// lib/secrets.js. Nothing sensitive is hardcoded here.

import jwt from "jsonwebtoken";
import { getSecret } from "./secrets.js";

// ---------------------------------------------------------------------------
// Secret configuration
// ---------------------------------------------------------------------------

export const SECRET_NAME = "sundial/salesforce/connected-app";

// We do not yet know the exact field names inside the secret (the deploy IAM
// user can't read it). Rather than hardcode one guess, each logical value lists
// the candidate field names we'll accept, in priority order. resolveConnectedApp-
// Fields() picks the first candidate present, so the token flow and the
// diagnostic handler resolve names identically from one source of truth.
export const CONNECTED_APP_FIELD_CANDIDATES = {
  consumerKey: ["consumer_key", "consumerKey", "client_id", "clientId"], // -> JWT iss
  username: ["username", "integration_username", "sub"],                 // -> JWT sub
  privateKey: ["private_key", "privateKey", "key"],                      // -> JWT signature
  loginUrl: ["login_url", "loginUrl", "sf_login_url"],                   // -> JWT aud + token endpoint
};

/**
 * Escape a string for safe inclusion inside a single-quoted SOQL string literal.
 * SOQL has no bind parameters over the REST query API, so any user/identity-
 * derived value MUST be escaped before interpolation. Escapes backslash first,
 * then single quote (order matters so we don't double-escape).
 *
 * @param {string} value
 * @returns {string} The escaped value (without surrounding quotes).
 */
export function soqlEscapeString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Resolve the four logical Connected App values from a raw secret object by
 * trying each candidate field name. Returns the matched field name per logical
 * value (or null), the raw value (or null), and the list of unresolved logical
 * keys. Never logs or mutates values.
 *
 * @param {object} secret - The parsed secret JSON.
 * @returns {{ matchedNames: object, values: object, missing: string[] }}
 */
export function resolveConnectedAppFields(secret) {
  const matchedNames = {};
  const values = {};

  for (const [logical, candidates] of Object.entries(
    CONNECTED_APP_FIELD_CANDIDATES
  )) {
    const found = candidates.find(
      (name) => secret[name] != null && secret[name] !== ""
    );
    matchedNames[logical] = found ?? null;
    values[logical] = found ? secret[found] : null;
  }

  const missing = Object.entries(matchedNames)
    .filter(([, name]) => name === null)
    .map(([logical]) => logical);

  return { matchedNames, values, missing };
}

// Salesforce REST API version used for queries.
const SF_API_VERSION = "v60.0";

// Defensive fallback if the secret somehow lacks a login_url. Production login
// host; a sandbox would use https://test.salesforce.com. The secret should
// carry login_url explicitly so this default is never actually exercised.
const DEFAULT_LOGIN_URL = "https://login.salesforce.com";

// JWT lifetime: short, since it's only used once to obtain a session token.
const JWT_EXP_SECONDS = 180; // now + 3 minutes

// How long we assume an issued access token stays valid. The JWT bearer token
// response does not reliably include expires_in, so we assume a conservative
// session lifetime and ALSO refresh on any 401 (the real safety net).
const ASSUMED_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const REFRESH_SKEW_MS = 2 * 60 * 1000; // refresh ~2 minutes before expiry

// ---------------------------------------------------------------------------
// Module-scope token cache (survives warm Lambda invocations)
// ---------------------------------------------------------------------------

// { access_token, instance_url, expiresAt } | null
let tokenCache = null;

/**
 * Read and validate the Connected App config from Secrets Manager.
 * Normalizes the PEM private key (handles JSON-escaped "\n" newlines).
 */
async function loadConnectedAppConfig() {
  const secret = await getSecret(SECRET_NAME);

  const { values, missing } = resolveConnectedAppFields(secret);

  // login_url is optional: if absent we default to the production login host.
  // The other three (consumer key, username, private key) are hard requirements.
  const requiredMissing = missing.filter((logical) => logical !== "loginUrl");
  if (requiredMissing.length > 0) {
    throw new Error(
      `Secret "${SECRET_NAME}" is missing expected field(s): ${requiredMissing.join(
        ", "
      )}. Add the field(s), or extend CONNECTED_APP_FIELD_CANDIDATES in lib/salesforce.js to match the secret's actual field names.`
    );
  }

  // Defensive backstop only — the secret now carries login_url explicitly.
  const loginUrl = values.loginUrl
    ? String(values.loginUrl).replace(/\/+$/, "") // trim trailing slash
    : DEFAULT_LOGIN_URL;

  return {
    consumerKey: values.consumerKey,
    username: values.username,
    privateKey: normalizePrivateKey(values.privateKey),
    loginUrl,
  };
}

/**
 * Accept the private key in either of two stored forms:
 *  - PEM: value starts with "-----BEGIN". We keep the literal-\n -> real-newline
 *    conversion as a backstop for keys whose newlines were escaped.
 *  - base64: anything else is treated as a base64-encoded PEM and decoded to
 *    UTF-8 to recover the PEM text. This is the format we standardize on, since
 *    base64 survives Secrets Manager storage without losing line breaks.
 * Returns PEM text suitable for crypto.createPrivateKey / jwt.sign (RS256).
 */
function normalizePrivateKey(raw) {
  const value = String(raw);
  if (value.trimStart().startsWith("-----BEGIN")) {
    return value.replace(/\\n/g, "\n");
  }
  return Buffer.from(value, "base64").toString("utf8");
}

/**
 * Perform the JWT bearer flow and return a fresh token bundle.
 * Always hits Salesforce; callers should prefer getSalesforceToken().
 */
async function requestNewToken() {
  const { consumerKey, username, privateKey, loginUrl } =
    await loadConnectedAppConfig();

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Build and sign the assertion. aud is the LOGIN url (not the instance url).
  const assertion = jwt.sign(
    {
      iss: consumerKey,
      sub: username,
      aud: loginUrl,
      exp: nowSeconds + JWT_EXP_SECONDS,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    // Attach the raw status/body so callers (e.g. the diagnostic) can report the
    // Salesforce error code (invalid_grant, no secrets, etc.) without re-parsing.
    const err = new Error(
      `Salesforce token request failed (${response.status})`
    );
    err.sfStatus = response.status;
    err.sfBody = text;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Salesforce token response was not JSON: ${text}`);
  }

  if (!data.access_token || !data.instance_url) {
    throw new Error(
      "Salesforce token response missing access_token or instance_url."
    );
  }

  // Prefer a server-provided expires_in if present; otherwise assume a TTL.
  const ttlMs = data.expires_in
    ? Number(data.expires_in) * 1000
    : ASSUMED_SESSION_TTL_MS;

  tokenCache = {
    access_token: data.access_token,
    // IMPORTANT: subsequent queries use instance_url from the response, not loginUrl.
    instance_url: data.instance_url,
    expiresAt: Date.now() + ttlMs,
  };

  return tokenCache;
}

/**
 * Get a valid Salesforce access token + instance URL, using the module-scope
 * cache when it is still comfortably valid, otherwise refreshing.
 *
 * @param {{ forceRefresh?: boolean }} [opts]
 * @returns {Promise<{ access_token: string, instance_url: string }>}
 */
export async function getSalesforceToken(opts = {}) {
  const { forceRefresh = false } = opts;

  const stillFresh =
    tokenCache &&
    !forceRefresh &&
    Date.now() < tokenCache.expiresAt - REFRESH_SKEW_MS;

  if (stillFresh) {
    return {
      access_token: tokenCache.access_token,
      instance_url: tokenCache.instance_url,
    };
  }

  const fresh = await requestNewToken();
  return {
    access_token: fresh.access_token,
    instance_url: fresh.instance_url,
  };
}

/**
 * Run a SOQL query and return ALL matched records, transparently following the
 * Salesforce query locator (`nextRecordsUrl`) to exhaustion.
 *
 * WHY THIS MATTERS: the Salesforce REST /query endpoint returns at most 2000
 * records per page and sets `done:false` + `nextRecordsUrl` when more remain.
 * An earlier version of this helper returned only the FIRST page, so any query
 * whose result set exceeded 2000 was silently truncated to 2000 rows — the root
 * cause of the cache holding only a fraction of a bulk-loaded object. We now page
 * until `done:true`. A caller that wants a bounded result should keep using a
 * SOQL `LIMIT` (Salesforce returns `done:true` at the limit, so paging stops
 * there) and/or pass `maxRecords` as a hard safety cap.
 *
 * Refreshes the token once and retries if Salesforce returns a 401 (on the first
 * page or on any continuation page).
 *
 * @param {string} soql - A SOQL query string.
 * @param {{ maxRecords?: number }} [opts] - Optional hard cap on total records
 *   accumulated across pages (defaults to no cap). Paging stops once reached.
 * @returns {Promise<Array<object>>} The full `records` array across all pages.
 */
export async function sfQuery(soql, opts = {}) {
  const { maxRecords = Infinity } = opts;

  // Fetch one page (either the initial /query or a /query/{locator} continuation)
  // with a single forced-refresh retry on 401. `relPath` is a Salesforce-relative
  // path beginning with /services/... — for continuations this is nextRecordsUrl.
  async function fetchPage(relPath) {
    async function run(forceRefresh) {
      const { access_token, instance_url } = await getSalesforceToken({ forceRefresh });
      return fetch(`${instance_url}${relPath}`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
    }
    let response = await run(false);
    // On a 401 the cached session is likely expired/invalid — refresh once, retry.
    if (response.status === 401) response = await run(true);

    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`Salesforce query failed (${response.status})`);
      err.sfStatus = response.status;
      err.sfBody = text;
      throw err;
    }
    return JSON.parse(text);
  }

  const initialPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  let page = await fetchPage(initialPath);

  const records = Array.isArray(page.records) ? page.records.slice() : [];
  // Follow the query locator until Salesforce reports done, or we hit the cap.
  // nextRecordsUrl is already a Salesforce-relative path (e.g.
  // /services/data/v60.0/query/01g...-2000), so it's used verbatim against the
  // instance URL — no re-encoding.
  while (!page.done && page.nextRecordsUrl && records.length < maxRecords) {
    page = await fetchPage(page.nextRecordsUrl);
    if (Array.isArray(page.records)) records.push(...page.records);
  }

  return maxRecords === Infinity ? records : records.slice(0, maxRecords);
}

/**
 * Update a Salesforce record by Id with an arbitrary field map (REST PATCH).
 * The single shared write path for every Sundial Lambda — same token/instance the
 * reads use, with one forced-refresh retry on a 401. Success is 204 No Content.
 *
 * Tenant scoping is the CALLER's responsibility: prove the record belongs to the
 * caller's tenant before calling this (e.g. a tenant-scoped SELECT pre-check), or
 * only call it for records already resolved under the right tenant. This helper
 * intentionally does no Client__c filtering of its own — it addresses one record
 * by its own Id.
 *
 * @param {string} sfObject - e.g. "Sundial_Solar__c"
 * @param {string} id - the record Id to update
 * @param {object} fields - { Api_Name__c: value, ... } to set
 * @returns {Promise<{ ok: true, id: string }>}
 * @throws an Error carrying .sfStatus and .sfBody on a non-2xx (so callers can
 *         log/surface the exact Salesforce validation message).
 */
export async function sfUpdateRecord(sfObject, id, fields) {
  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({ forceRefresh });
    return fetch(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/${encodeURIComponent(
        id
      )}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fields),
      }
    );
  }

  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Salesforce update failed (${resp.status})`);
    err.sfStatus = resp.status;
    err.sfBody = text;
    throw err;
  }
  return { ok: true, id };
}

/**
 * Delete a Salesforce record (REST DELETE) by id. Companion to sfUpdateRecord —
 * same token/instance + 401 retry. Used for teardown (e.g. the e2e verify script's
 * cleanup); no Lambda write-path uses it. Tenant scoping is the caller's concern.
 *
 * @param {string} sfObject - e.g. "Sundial_User__c"
 * @param {string} id - the record id to delete
 * @returns {Promise<{ ok: true, id: string }>}
 * @throws Error with .sfStatus/.sfBody on a non-2xx.
 */
export async function sfDeleteRecord(sfObject, id) {
  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({ forceRefresh });
    return fetch(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/${encodeURIComponent(
        id
      )}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );
  }

  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Salesforce delete failed (${resp.status})`);
    err.sfStatus = resp.status;
    err.sfBody = text;
    throw err;
  }
  return { ok: true, id };
}

/**
 * Create a Salesforce record (REST POST) with an arbitrary field map. Companion to
 * sfUpdateRecord — the shared create path. Same token/instance + 401 retry. Returns
 * the new record's id. Tenant scoping is the caller's responsibility (pass Client__c).
 *
 * @param {string} sfObject - e.g. "Sundial_Solar__c"
 * @param {object} fields - { Api_Name__c: value, ... }
 * @returns {Promise<{ ok: true, id: string }>}
 * @throws Error with .sfStatus/.sfBody on a non-2xx.
 */
export async function sfCreateRecord(sfObject, fields) {
  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({ forceRefresh });
    return fetch(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fields),
      }
    );
  }

  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);

  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`Salesforce create failed (${resp.status})`);
    err.sfStatus = resp.status;
    err.sfBody = text;
    throw err;
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* success bodies are JSON { id, success, errors } */
  }
  return { ok: true, id: data?.id ?? null };
}
