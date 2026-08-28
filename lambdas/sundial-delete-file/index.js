// sundial-delete-file — DELETE /files/by-id/{fileId}
//
// HARD-deletes one S3 object, gated by tenant ownership of the record the file
// lives under. (Design divergence, intentional: docs/file-storage.md describes a
// SOFT delete in a metadata table; per current instructions this does a real
// s3:DeleteObject.)
//
// CONTRACT — the caller identifies the object by its S3 KEY plus the record's
// object type. Precedence (first present wins):
//   1) ?object=<key>&key=<url-encoded full key>           (PRIMARY — recommended)
//   2) ?object=<key>&recordId=<id>&fileName=<name>
//   3) {fileId} path segment = url-encoded full key       (fallback)
// The primary query form is recommended because encoded slashes (%2F) inside a
// path segment can be mangled by API Gateway.
//
// SAFETY: the key must live under SUNDIAL/{recordId}/, contain no "..", and the
// recordId embedded in the key must be tenant-owned. We only ever delete that
// exact key — never anything outside the owning record's folder or the SUNDIAL/
// prefix.

import { resolveIdentity } from "../../lib/identity.js";
import {
  alwaysEnforcedAccess,
  assertActionOnRecord,
  assertAction,
} from "../../lib/access-enforce.js";
import {
  corsHeaders,
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  httpMethod,
} from "../../lib/http.js";
import {
  resolveFileObject,
  assertTenantOwnsRecord,
  sanitizeFileName,
  buildKey,
  S3_BUCKET,
  S3_REGION,
  S3_PREFIX,
} from "../../lib/file-access.js";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: S3_REGION });

function safeDecode(v) {
  if (v == null) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "DELETE") {
    return jsonResponse(405, cors, {
      error: "method_not_allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const pp = event?.pathParameters || {};
    const qs = event?.queryStringParameters || {};
    const objectKey = qs.object || null;

    // Resolve the target key by precedence.
    let key = safeDecode(qs.key);
    if (!key && qs.recordId && qs.fileName) {
      key = buildKey(qs.recordId, sanitizeFileName(qs.fileName));
    }
    if (!key && pp.fileId) key = safeDecode(pp.fileId);

    if (!key) {
      return jsonResponse(400, cors, {
        error: "missing_key",
        code: "MISSING_KEY",
        message:
          "Provide the S3 key via ?key=<url-encoded> (or ?recordId=&fileName=).",
      });
    }
    if (!resolveFileObject(objectKey)) {
      return jsonResponse(400, cors, {
        error: "unsupported_object",
        code: "OBJECT_NOT_ALLOWED",
      });
    }

    // --- Key-shape safety: SUNDIAL/{recordId}/{fileName...}, no traversal. ---
    if (key.includes("..")) {
      return jsonResponse(400, cors, { error: "invalid_key", code: "INVALID_KEY" });
    }
    const parts = key.split("/");
    // parts[0] = SUNDIAL, parts[1] = recordId, parts[2..] = filename (subfolders
    // not expected, but a trailing segment must exist).
    if (parts[0] !== S3_PREFIX || parts.length < 3 || !parts[1] || !parts[2]) {
      return jsonResponse(400, cors, { error: "invalid_key", code: "INVALID_KEY" });
    }
    const recordId = parts[1];

    // Auth — tenant only from the verified token.
    let identity;
    try {
      identity = await resolveIdentity(headers["authorization"]);
    } catch (err) {
      const m = mapIdentityError(err?.code);
      if (m) return jsonResponse(m.status, cors, m.body);
      throw err;
    }
    const tenantId = identity.tenantId;
    if (!tenantId) {
      return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    }

    // ACCESS MODEL (D-064 §3.6): DELETE IS TENANT-SCOPE ONLY, for customer files as
    // well as solar. A rep may upload to their own customer and may not remove what is
    // there — deletion is destructive and unrecoverable from the portal, and the record
    // outlives the rep's involvement with it.
    //
    // The record id checked is the one EMBEDDED IN THE KEY, the same one the ownership
    // gate below uses, so the visibility question and the deletion target cannot differ.
    const access = alwaysEnforcedAccess(identity);
    const denied = await assertActionOnRecord(
      `files.${objectKey}.delete`,
      objectKey,
      recordId,
      access
    );
    if (denied) return jsonResponse(denied.status, cors, denied.body);

    // Ownership gate on the recordId EMBEDDED IN THE KEY. You can only delete
    // within a record folder your tenant owns.
    const owned = await assertTenantOwnsRecord(recordId, objectKey, tenantId);
    if (!owned) {
      return jsonResponse(404, cors, {
        error: "not_found",
        code: "RECORD_NOT_FOUND",
      });
    }

    // Final belt-and-suspenders: the key must sit under SUNDIAL/{ownedRecordId}/.
    const expectedPrefix = `${S3_PREFIX}/${recordId}/`;
    if (!key.startsWith(expectedPrefix)) {
      return jsonResponse(400, cors, { error: "invalid_key", code: "INVALID_KEY" });
    }

    await s3.send(
      new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })
    );

    return jsonResponse(200, cors, { success: true, key });
  } catch (err) {
    console.error("delete-file error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
