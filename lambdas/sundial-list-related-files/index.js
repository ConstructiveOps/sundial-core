// sundial-list-related-files — GET /files/by-record/{recordId}/related?object=<key>
//
// Returns a record's own files plus (for now) EMPTY related-file groups. The
// tenant-ownership gate on the PARENT record is fully implemented; the
// cross-object traversal (parent -> linked Customer / Roofing / PO / etc.) is
// DEFERRED — see the marked TODO below — pending confirmation of the
// Sundial_PO__c relationship fields. The response shape is final so the frontend
// can render it and traversal can be filled in without a contract change.
//
// TENANT ISOLATION: resolveIdentity -> assertTenantOwnsRecord(recordId, object,
// tenantId) -> 404 if not owned. When traversal is added, each discovered related
// record must ALSO be confirmed same-tenant before its files are included.

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
    if (!resolveFileObject(objectKey)) {
      return jsonResponse(400, cors, {
        error: "unsupported_object",
        code: "OBJECT_NOT_ALLOWED",
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

    // Gate on the PARENT record.
    const owned = await assertTenantOwnsRecord(recordId, objectKey, tenantId);
    if (!owned) {
      return jsonResponse(404, cors, {
        error: "not_found",
        code: "RECORD_NOT_FOUND",
      });
    }

    const files = await listRecordFiles(s3, recordId);

    // TODO(related-traversal): traverse parent -> linked records per
    // docs/file-storage.md (Solar -> Sundial_Customer__c, Linked_Roofing_Project__c,
    // related Sundial_PO__c; Customer -> its projects; etc.), and for EACH
    // discovered record re-assert same-tenant ownership before listing its files,
    // pushing { sourceObject, sourceRecordId, files } groups here. Deferred until
    // the Sundial_PO__c (and remaining) relationship fields are confirmed.
    const relatedFileGroups = [];

    return jsonResponse(200, cors, {
      recordId,
      object: objectKey,
      files,
      relatedFileGroups,
    });
  } catch (err) {
    console.error("list-related-files error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
