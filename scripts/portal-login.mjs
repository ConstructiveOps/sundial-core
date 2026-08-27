// Shared portal login for the access-model scripts.
//
// Two scripts need to authenticate as a ZZ TEST user and call the deployed API
// (verify-auth-me-access.mjs, repair-mis-stamped-users.mjs). Both were resolving the
// Supabase publishable key and exchanging a password for a token; the second one only
// read the key from the environment and failed when it was not exported, while the
// first fell back to the portal repo. One helper, one behaviour.
//
// ⚠️ THE TWO CREDENTIALS HERE ARE NOT THE SAME KIND OF THING.
//
//   The publishable ("anon") key SHIPS IN THE BROWSER BUNDLE by design. Reading it from
//   ../harmon-crm/.env.local is fine and it may appear in logs.
//
//   The ZZ TEST PASSWORDS come from Secrets Manager `sundial/test-users` and are NEVER
//   written to a file, echoed, or logged (CLAUDE.md). They belong to test accounts only
//   — never a live user's password, for any reason.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSecret } from "../lib/secrets.js";
import { EMAIL } from "./seed-access-test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Supabase URL + publishable key: environment first, then the portal repo's .env.local. */
export function resolveSupabasePublic() {
  let url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    const envPath = path.join(HERE, "..", "..", "harmon-crm", ".env.local");
    try {
      for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (m[1] === "VITE_SUPABASE_URL") url = url || v;
        if (m[1] === "VITE_SUPABASE_ANON_KEY") key = key || v;
      }
    } catch {
      /* fall through to the error below */
    }
  }
  if (!url || !key) {
    throw new Error(
      "Could not resolve the Supabase URL and publishable key.\n" +
        "Set SUPABASE_URL and SUPABASE_ANON_KEY, or ensure ../harmon-crm/.env.local carries\n" +
        "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }
  return { url, key };
}

/** The ZZ TEST password map from Secrets Manager. Never logged, never written down. */
export const loadTestPasswords = () => getSecret("sundial/test-users");

/**
 * Exchange a ZZ TEST email + password for a Supabase access token.
 * @returns {Promise<{token: string|null, status: number}>}
 */
export async function loginAs(email, password) {
  const { url, key } = resolveSupabasePublic();
  const resp = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await resp.json().catch(() => ({}));
  return { token: body?.access_token ?? null, status: resp.status };
}

/** Log in as a ZZ TEST user by slug (e.g. "admin" -> tim+zz-admin@...). */
export async function loginAsTestUser(slug, passwords) {
  const email = EMAIL(slug);
  const pw = (passwords ?? (await loadTestPasswords()))[email];
  if (!pw) throw new Error(`No password for ${email} in sundial/test-users.`);
  return { email, ...(await loginAs(email, pw)) };
}
