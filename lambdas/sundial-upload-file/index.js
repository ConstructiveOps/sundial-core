// sundial-upload-file — POST /files/by-record/{recordId}/upload
//
// Mints a short-lived presigned S3 PUT URL so the browser uploads bytes DIRECTLY
// to S3 (bytes never stream through this Lambda). Returns the presigned uploadUrl,
// the eventual publicUrl, and the key.
//
// Body: { object, recordId, fileName, contentType } (recordId may also come from
// the path). base64-decoded if API Gateway flagged it.
//
// TENANT ISOLATION: resolveIdentity -> assertTenantOwnsRecord(recordId, object,
// tenantId) -> 404 if not owned. fileName is sanitized so the key can never
// escape SUNDIAL/{recordId}/.

import { resolveIdentity } from "../../lib/identity.js";
import {
  corsHeaders,
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  parseJsonBody,
  httpMethod,
} from "../../lib/http.js";
import {
  resolveFileObject,
  assertTenantOwnsRecord,
  sanitizeFileName,
  buildKey,
  publicUrlForKey,
  S3_BUCKET,
  S3_REGION,
} from "../../lib/file-access.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: S3_REGION });
const UPLOAD_EXPIRY_SECONDS = 300; // ~5 minutes

export const handler = async (event) => {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "POST") {
    return jsonResponse(405, cors, {
      error: "method_not_allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const parsed = parseJsonBody(event);
    if (!parsed.ok) {
      return jsonResponse(400, cors, {
        error: "invalid_body",
        code: "INVALID_BODY",
        message:
          'Expected JSON { "object", "recordId", "fileName", "contentType" }.',
      });
    }
    const body = parsed.data;
    const pp = event?.pathParameters || {};
    const recordId = pp.recordId || body.recordId || null;
    const objectKey = body.object || null;
    const contentType = body.contentType || null;

    // Validate presence.
    if (!recordId || !objectKey || !body.fileName || !contentType) {
      return jsonResponse(400, cors, {
        error: "missing_fields",
        code: "MISSING_FIELDS",
        message: "object, recordId, fileName, and contentType are all required.",
      });
    }
    if (!resolveFileObject(objectKey)) {
      return jsonResponse(400, cors, {
        error: "unsupported_object",
        code: "OBJECT_NOT_ALLOWED",
      });
    }

    // Sanitize the filename; reject if nothing usable survives.
    const safeName = sanitizeFileName(body.fileName);
    if (!safeName) {
      return jsonResponse(400, cors, {
        error: "invalid_file_name",
        code: "INVALID_FILE_NAME",
      });
    }

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

    // Tenant-ownership gate before signing anything.
    const owned = await assertTenantOwnsRecord(recordId, objectKey, tenantId);
    if (!owned) {
      return jsonResponse(404, cors, {
        error: "not_found",
        code: "RECORD_NOT_FOUND",
      });
    }

    const key = buildKey(recordId, safeName);
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: UPLOAD_EXPIRY_SECONDS }
    );

    // The browser PUTs bytes to uploadUrl with Content-Type = contentType (it is
    // part of the signature), then references the file at publicUrl.
    return jsonResponse(200, cors, {
      uploadUrl,
      publicUrl: publicUrlForKey(key),
      key,
      expiresIn: UPLOAD_EXPIRY_SECONDS,
    });
  } catch (err) {
    console.error("upload-file error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
