// real-io.js — the real outside world for the seed: Salesforce, Supabase, Secrets Manager,
// S3 and the local migration/demo folder. Imported ONLY by scripts/seed-demo-tenant.mjs;
// the tests pass fakes with the same shape instead (scripts/demo-seed/fakes.js), which is
// why nothing else in demo-seed/ imports lib/salesforce.js or an AWS client directly.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { sfQuery, sfCreateRecord, sfUpdateRecord, describeObject } from "../../lib/salesforce.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { S3_BUCKET, S3_REGION } from "../../lib/file-access.js";
import { OUT_DIR_PARTS } from "./policy.js";
import { localFiles as localFilesIn } from "./local-files.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The same region lib/secrets.js pins for every Sundial secret.
const SECRETS_REGION = "us-west-1";

/** The run's local folder, migration/demo (see local-files.js for the atomic, retried write). */
export function localFiles(outDir = resolve(REPO_ROOT, ...OUT_DIR_PARTS), opts = {}) {
  return localFilesIn(outDir, opts);
}

export function createRealIo() {
  let secretsClient = null;
  let s3Client = null;
  let lockedNoteShown = false;
  const secrets = () => (secretsClient ??= new SecretsManagerClient({ region: SECRETS_REGION }));
  return {
    sf: { sfQuery, sfCreateRecord, sfUpdateRecord, describeObject },
    getSupabase: () => getSupabaseClient(),
    secrets: {
      /** The secret's JSON, or null when it does not exist yet. Read fresh every time (no cache). */
      async load(name) {
        try {
          const r = await secrets().send(new GetSecretValueCommand({ SecretId: name }));
          return r.SecretString ? JSON.parse(r.SecretString) : {};
        } catch (e) {
          if (/ResourceNotFound/i.test(e?.name || e?.message || "")) return null;
          throw e;
        }
      },
      async save(name, obj, existed) {
        const SecretString = JSON.stringify(obj, null, 2);
        if (existed) await secrets().send(new PutSecretValueCommand({ SecretId: name, SecretString }));
        else {
          await secrets().send(new CreateSecretCommand({
            Name: name,
            Description: "Passwords for the Sundial DEMO tenant's logins, plus the seed's run record under _run (scripts/seed-demo-tenant.mjs). Demo accounts only - never a client's user.",
            SecretString,
          }));
        }
      },
    },
    s3: {
      async putObject({ key, body, contentType }) {
        s3Client ??= new S3Client({ region: S3_REGION });
        await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
      },
    },
    files: localFiles(undefined, {
      // Said once: the file was saved, just not by the atomic rename.
      onFallback: (name, code) => {
        if (lockedNoteShown) return;
        lockedNoteShown = true;
        console.log(`  note: migration/demo/${name} was held open by another program (${code}); it was saved by overwriting it in place instead of by rename.`);
      },
    }),
    now: () => new Date(),
    env: process.env,
    log: (line) => console.log(line),
    // 24 random characters plus a fixed tail, so any complexity rule is met without a retry loop
    // (the same recipe as scripts/seed-access-test-fixtures.mjs).
    randomPassword: () => `${randomBytes(18).toString("base64url")}aA1!`,
  };
}
