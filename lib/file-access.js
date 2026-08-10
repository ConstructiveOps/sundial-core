// lib/file-access.js — shared tenant-ownership + S3 helpers for the Sundial file
// endpoints (list, related, upload, delete).
//
// TENANT ISOLATION is the whole point of this module: every file operation that
// touches a record must first prove the caller's tenant owns that record, using
// assertTenantOwnsRecord(). tenantId comes ONLY from resolveIdentity (the verified
// token) — never from request input.
//
// Object resolution is EXPLICIT (Option B): the caller passes an allowlisted
// object key (solar/customer/roofing/po/user). We do NOT guess the sObject from a
// record id's key-prefix. An unknown/missing key resolves to null and every gate
// FAILS CLOSED (denies).
//
// Value-safety: never logs tokens/secrets; nothing here echoes credentials.

import { sfQuery, soqlEscapeString } from "./salesforce.js";
import { ListObjectsV2Command, CopyObjectCommand } from "@aws-sdk/client-s3";

// Supabase file-metadata table (docs/file-storage.md). NOTE: the currently
// deployed Files tab lists directly from S3 (listRecordFiles), so a file already
// shows once it lands under SUNDIAL/{id}/. This registration exists to align with
// the DOCUMENTED design where the Files tab reads sundial_file_metadata (search,
// category, audit, soft-delete). Callers should treat it as BEST-EFFORT.
export const FILE_METADATA_TABLE = "sundial_file_metadata";

// Object allowlist for file operations — short key -> Salesforce object. Mirrors
// sundial-sf-query's allowlist. Anything not here is rejected (fail closed).
export const FILE_OBJECT_ALLOWLIST = {
  solar: "Sundial_Solar__c",
  customer: "Sundial_Customer__c",
  roofing: "Sundial_Roofing__c",
  po: "Sundial_PO__c",
  user: "Sundial_User__c",
};

export const S3_BUCKET = "sfsolproj";
export const S3_REGION = "us-west-1";
export const S3_PREFIX = "SUNDIAL"; // top-level prefix; every key is SUNDIAL/{id}/{file}

// Resolve an allowlisted object key to its Salesforce object, or null if the key
// is missing/unknown (caller must fail closed).
export function resolveFileObject(objectKey) {
  if (!objectKey) return null;
  return FILE_OBJECT_ALLOWLIST[objectKey] || null;
}

// Assert the caller's tenant owns a record. Returns true iff a row exists for
// that id under that Client__c. `objectKey` must be allowlisted; a missing/unknown
// key, id, or tenantId returns false (FAIL CLOSED). tenantId comes ONLY from
// resolveIdentity. Both id and tenantId are bound through soqlEscapeString.
export async function assertTenantOwnsRecord(recordId, objectKey, tenantId) {
  const sfObject = resolveFileObject(objectKey);
  if (!sfObject || !recordId || !tenantId) return false; // fail closed
  const soql =
    `SELECT Id FROM ${sfObject} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' ` +
    `LIMIT 1`;
  const rows = await sfQuery(soql);
  return Array.isArray(rows) && rows.length > 0;
}

// Sanitize a filename so the resulting key can NEVER escape SUNDIAL/{recordId}/.
// Steps: take only the final path segment (kills "../", "a/b", backslashes),
// collapse ".." runs, map anything outside a conservative URL-safe charset to "_"
// (spaces included, so keys need no URL-encoding and the public URL matches the
// signed key exactly), and strip leading dots. Returns "" if nothing survives
// (caller rejects empty).
export function sanitizeFileName(name) {
  if (name == null) return "";
  let n = String(name).trim();
  n = n.split(/[\\/]/).pop(); // final segment only -> no path separators
  n = n.replace(/\.\.+/g, "."); // collapse ".." sequences
  n = n.replace(/[^A-Za-z0-9._()\-]/g, "_"); // URL-safe conservative charset
  n = n.replace(/^\.+/, ""); // no leading dots (hidden / "." / "..")
  return n;
}

// Canonical S3 key for a record's file.
export function buildKey(recordId, fileName) {
  return `${S3_PREFIX}/${recordId}/${fileName}`;
}

// Public URL for a key. Keys are URL-safe by construction (sanitizeFileName), and
// Salesforce ids are alphanumeric, so a plain join yields a valid URL.
export function publicUrlForKey(key) {
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

// Register one file's metadata row in Supabase (sundial_file_metadata). The
// SINGLE shared write path for file metadata, so every producer (uploads, budget
// snapshots, future writers) inserts an identically-shaped row. tenant_id must be
// the record's Client__c value (the caller resolves it); nothing here is inferred.
//
// Returns { id } (the new row's id) on success. Throws on a Supabase error so a
// caller that cares can catch it — but most callers should treat this as
// best-effort (the file itself is already in S3) and not fail their operation.
//
// @param {import("@supabase/supabase-js").SupabaseClient} supabase
// @param {object} meta - { s3Key, fileName, tenantId, sfRecordId, sfObjectType,
//   uploadedByUserId, uploadedByUserName, fileSizeBytes, mimeType, category,
//   description, subfolder }
export async function registerFileMetadata(supabase, meta) {
  const row = {
    s3_key: meta.s3Key,
    file_name: meta.fileName,
    tenant_id: meta.tenantId ?? null,
    sf_record_id: meta.sfRecordId ?? null,
    sf_object_type: meta.sfObjectType ?? null,
    uploaded_by_user_id: meta.uploadedByUserId ?? null,
    uploaded_by_user_name: meta.uploadedByUserName ?? null,
    file_size_bytes: meta.fileSizeBytes ?? null,
    mime_type: meta.mimeType ?? null,
    category: meta.category ?? null,
    description: meta.description ?? null,
    subfolder: meta.subfolder ?? null,
  };
  const { data, error } = await supabase
    .from(FILE_METADATA_TABLE)
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`file metadata insert failed: ${error.message}`);
  return data;
}

// List all files directly under SUNDIAL/{recordId}/ in the bucket. Returns a
// compact projection of what S3 knows (no Supabase metadata in this design):
// { fileName, key, publicUrl, size, lastModified }. Folder placeholder keys
// (ending in "/") are skipped. Paginates through all results.
export async function listRecordFiles(s3, recordId) {
  const prefix = `${S3_PREFIX}/${recordId}/`;
  const files = [];
  let ContinuationToken;
  do {
    const out = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken,
      })
    );
    for (const obj of out.Contents || []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue; // skip folder markers
      files.push({
        fileName: obj.Key.slice(prefix.length),
        key: obj.Key,
        publicUrl: publicUrlForKey(obj.Key),
        size: obj.Size,
        lastModified: obj.LastModified ? obj.LastModified.toISOString() : null,
      });
    }
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return files;
}

// Build the CopySource value for CopyObject: "bucket/key" with the key URI-encoded.
// S3 requires CopySource to be URL-encoded, but the "/" separators must stay literal
// — so encode per segment. Without this, any key containing a space, "+", "(" etc.
// fails or silently copies to the wrong key.
export function encodeCopySource(bucket, key) {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// Run `work` over `items` with at most `limit` in flight. Keeps a large folder from
// firing hundreds of simultaneous S3 calls while still finishing quickly.
async function mapWithConcurrency(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await work(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Server-side copy of every file under SUNDIAL/{sourceRecordId}/ to
// SUNDIAL/{targetRecordId}/, preserving the relative path (so filenames — and any
// subfolders — survive). Bytes never pass through the Lambda: S3 CopyObject moves
// them internally.
//
// IDEMPOTENT: destination keys are deterministic, so a re-run overwrites in place
// rather than duplicating. Re-running after a partial failure is the retry story.
//
// PER-OBJECT FAULT ISOLATION: one object failing does NOT abort the batch — it is
// captured in `failed` and the rest still copy. The caller decides what to do.
//
// Returns { copied: [{ fileName, sourceKey, key, size }],
//           failed: [{ fileName, sourceKey, error }] }.
export async function copyRecordFiles(
  s3,
  sourceRecordId,
  targetRecordId,
  { concurrency = 8 } = {}
) {
  const sourceFiles = await listRecordFiles(s3, sourceRecordId);
  const copied = [];
  const failed = [];

  await mapWithConcurrency(sourceFiles, concurrency, async (file) => {
    // file.fileName is the path RELATIVE to SUNDIAL/{sourceRecordId}/, so nested
    // folders are preserved. It can never escape the destination prefix: S3 keys
    // are opaque strings, and the result is always prefixed SUNDIAL/{target}/.
    const destKey = `${S3_PREFIX}/${targetRecordId}/${file.fileName}`;
    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: S3_BUCKET,
          Key: destKey,
          CopySource: encodeCopySource(S3_BUCKET, file.key),
          MetadataDirective: "COPY",
        })
      );
      copied.push({
        fileName: file.fileName,
        sourceKey: file.key,
        key: destKey,
        size: file.size ?? null,
      });
    } catch (e) {
      const error = e?.message || String(e);
      console.error(`copy failed ${file.key} -> ${destKey}: ${error}`);
      failed.push({ fileName: file.fileName, sourceKey: file.key, error });
    }
  });

  return { copied, failed };
}
