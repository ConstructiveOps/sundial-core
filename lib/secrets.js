// Shared Secrets Manager helper for all Sundial Lambda functions.
//
// Reads a named secret from AWS Secrets Manager (us-west-1), parses it as JSON,
// and caches the parsed object in module scope. Lambda keeps a container warm
// between invocations, so this cache means we only pay the Secrets Manager fetch
// on a cold start — warm invocations reuse the in-memory copy.
//
// No secret values are ever hardcoded here; everything is resolved at runtime.

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// Region is pinned to match the rest of the Sundial backend.
const REGION = "us-west-1";

// One client per warm container is enough.
const client = new SecretsManagerClient({ region: REGION });

// Module-scope cache: secret name -> parsed JSON object. Survives warm invokes.
const cache = new Map();

/**
 * Fetch and parse a JSON secret, caching the result for warm invocations.
 *
 * @param {string} secretName - The Secrets Manager secret id/name.
 * @returns {Promise<object>} The parsed JSON object stored in the secret.
 * @throws if the secret has no string value or is not valid JSON.
 */
export async function getSecret(secretName) {
  // Return the cached parse if we've already fetched this secret in this container.
  if (cache.has(secretName)) {
    return cache.get(secretName);
  }

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  if (!response.SecretString) {
    // Binary secrets aren't used by Sundial; treat their absence as an error.
    throw new Error(`Secret "${secretName}" has no SecretString to parse.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch (err) {
    throw new Error(
      `Secret "${secretName}" is not valid JSON: ${err.message}`
    );
  }

  cache.set(secretName, parsed);
  return parsed;
}

/**
 * Test/maintenance helper: clear the in-memory secret cache. Not used in normal
 * request flow, but handy if a secret is rotated and a long-lived warm container
 * needs to pick up the new value without a cold start.
 */
export function clearSecretCache() {
  cache.clear();
}
