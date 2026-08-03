// sundial-list-files — GET /files/by-record/{recordId}?object=<key>
//
// Lists the files stored under SUNDIAL/{recordId}/ in the sfsolproj bucket for a
// record the caller's tenant owns. Downloads are plain PUBLIC URLs (no presign) —
// this endpoint just returns the object list + public URLs.
//
// TENANT ISOLATION: resolveIdentity -> assertTenantOwnsRecord(recordId, object,
// tenantId). A record the tenant doesn't own is indistinguishable from one that
// doesn't exist -> 404 (never reveal cross-tenant existence). The object key is
// EXPLICIT (allowlisted); no key-prefix guessing.
//
// NOTE (design divergence, intentional): docs/file-storage.md describes listing
// from the Supabase sundial_file_metadata table; per current instructions this
// lists S3 directly, so the response carries only what S3 knows (no category /
// uploader / description).

import { resolveIdentity } from "../../lib/identity.js";
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
  listRecordFiles,
  S3_REGION,
} from "../../lib/file-access.js";
import { S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: S3_REGION });

export const handler = async (event) => {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "GET") {
    return jsonResponse(405, cors, {
      error: "method_not_allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const pp = event?.pathParameters || {};
    const qs = event?.queryStringParameters || {};
    const recordId = pp.recordId || qs.recordId || null;
    const objectKey = qs.object || null;

    if (!recordId) {
      return jsonResponse(400, cors, {
        error: "missing_record_id",
        code: "MISSING_RECORD_ID",
      });
    }
    // Explicit object is required and must be allowlisted (fail closed).
    if (!resolveFileObject(objectKey)) {
      return jsonResponse(400, cors, {
        error: "unsupported_object",
        code: "OBJECT_NOT_ALLOWED",
      });
    }

    // Auth — tenant derived ONLY from the verified token.
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

    // TEMP — Sales Rep hard-restrict (remove with the per-user visibility feature;
    // see TASKS.md "Sales Rep visibility"). A caller whose Hierarchy_Level__c ===
    // "Sales Rep" may NOT list/download SOLAR record files (Customer files stay
    // allowed). Solar files can expose install/proposal docs across reps.
    if (identity?.user?.hierarchyLevel === "Sales Rep" && objectKey === "solar") {
      return jsonResponse(403, cors, {
        error: "forbidden",
        code: "SALES_REP_FILES_RESTRICTED",
      });
    }

    // Tenant-ownership gate. Not owned (or unknown object) -> 404.
    const owned = await assertTenantOwnsRecord(recordId, objectKey, tenantId);
    if (!owned) {
      return jsonResponse(404, cors, {
        error: "not_found",
        code: "RECORD_NOT_FOUND",
      });
    }

    const files = await listRecordFiles(s3, recordId);
    return jsonResponse(200, cors, { recordId, object: objectKey, files });
  } catch (err) {
    console.error("list-files error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
