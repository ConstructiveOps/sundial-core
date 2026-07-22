// Service-role Supabase client factory for Sundial Lambda functions.
//
// Reads the Supabase URL + service-role key from the sundial/supabase/service-role
// secret and constructs a @supabase/supabase-js client, cached in module scope so
// warm invocations reuse it.
//
// IMPORTANT: the service-role key BYPASSES Row Level Security. This client can
// read/write any tenant's rows. Callers are responsible for applying tenant
// filtering EXPLICITLY in every query (e.g. .eq(<tenant column>, tenantId) from
// resolveIdentity). There is no implicit isolation at this layer.
//
// Value-safety: never logs or returns the service-role key.

import { createClient } from "@supabase/supabase-js";
import { getSecret } from "./secrets.js";

export const SUPABASE_SECRET_NAME = "sundial/supabase/service-role";

// The secret's exact field names aren't assumed — we accept these candidates in
// priority order (mirrors the pattern used for the Salesforce connected-app
// secret). Adjust here if the secret uses different names.
export const SUPABASE_URL_CANDIDATES = [
  "url",
  "supabase_url",
  "SUPABASE_URL",
  "project_url",
  "VITE_SUPABASE_URL",
];
export const SUPABASE_KEY_CANDIDATES = [
  "service_role_key",
  "service_role",
  "serviceRoleKey",
  "service_role_secret",
  "SUPABASE_SERVICE_ROLE_KEY",
  "key",
];

let cachedClient = null;

function pick(secret, candidates) {
  for (const name of candidates) {
    if (secret[name] != null && secret[name] !== "") {
      return { name, value: secret[name] };
    }
  }
  return { name: null, value: null };
}

/**
 * Resolve { url, serviceRoleKey, urlField, keyField } from the secret.
 * urlField/keyField are the matched field NAMES (safe to log); the key VALUE is
 * never logged. Throws a clear error naming missing fields.
 */
export async function getSupabaseConfig() {
  const secret = await getSecret(SUPABASE_SECRET_NAME);
  const url = pick(secret, SUPABASE_URL_CANDIDATES);
  const key = pick(secret, SUPABASE_KEY_CANDIDATES);

  const missing = [];
  if (!url.value) missing.push("url");
  if (!key.value) missing.push("service_role_key");
  if (missing.length > 0) {
    throw new Error(
      `Secret "${SUPABASE_SECRET_NAME}" missing field(s): ${missing.join(
        ", "
      )}. Checked URL candidates [${SUPABASE_URL_CANDIDATES.join(
        ", "
      )}] and key candidates [${SUPABASE_KEY_CANDIDATES.join(", ")}].`
    );
  }

  return {
    url: url.value,
    serviceRoleKey: key.value,
    urlField: url.name,
    keyField: key.name,
  };
}

/**
 * Get a cached service-role Supabase client. Bypasses RLS — apply tenant
 * filtering explicitly in every query.
 *
 * @returns {Promise<import("@supabase/supabase-js").SupabaseClient>}
 */
export async function getSupabaseClient() {
  if (cachedClient) return cachedClient;

  const { url, serviceRoleKey } = await getSupabaseConfig();

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cachedClient;
}
