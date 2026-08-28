// sundial-list-files — the file READ + COPY endpoints:
//
//   GET  /files/by-record/{recordId}?object=<key>
//        Lists the files stored under SUNDIAL/{recordId}/ in the sfsolproj bucket
//        for a record the caller's tenant owns. Downloads are plain PUBLIC URLs
//        (no presign) — this endpoint just returns the object list + public URLs.
//
//   POST /projects/{recordId}/files/copy-to-solar
//        Backs the "Create Project" button: server-side copies the CUSTOMER's files
//        into the Solar project's folder. {recordId} is a Sundial_Customer__c id
//        (the gateway's variable at that node is already named {recordId} — API
//        Gateway forbids sibling path variables with different names — but the
//        value is a customer id). See handleCopyToSolar below.
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
  alwaysEnforcedAccess,
  assertActionOnRecord,
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
  listRecordFiles,
  copyRecordFiles,
  registerFileMetadata,
  S3_REGION,
} from "../../lib/file-access.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { sfQuery, soqlEscapeString } from "../../lib/salesforce.js";
import { S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: S3_REGION });

const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";
// The ONLY copy destination. Read from the customer record server-side — a target
// id is never accepted from the caller, so no request can aim the copy elsewhere.
const SOLAR_LINK_FIELD = "Linked_Solar_Project__c";

// Detect POST /projects/{recordId}/files/copy-to-solar. Returns the customer id
// carried by the path, or null when this isn't the copy route.
function extractCopyToSolarCustomerId(event) {
  const path = event?.rawPath || event?.path || "";
  if (!/\/files\/copy-to-solar\/?$/.test(path)) return null;
  const pp = event?.pathParameters || {};
  // {recordId} is the gateway's variable name at /projects/{recordId}; customerId
  // is accepted too so a future rename of the resource can't break this.
  const fromParams = pp.recordId || pp.customerId;
  if (fromParams) return decodeURIComponent(fromParams);
  const m = path.match(/\/projects\/([^/]+)\/files\/copy-to-solar\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// POST /projects/{customerId}/files/copy-to-solar
//
// Copies every object under SUNDIAL/{customerId}/ to SUNDIAL/{solarRecordId}/ where
// solarRecordId is the customer's Linked_Solar_Project__c. Server-side CopyObject —
// bytes never move through this Lambda.
//
// SAFETY PROPERTIES:
//   - The destination comes ONLY from the tenant-verified customer record.
//   - Both the customer AND the resolved solar project are tenant-checked.
//   - Idempotent: destination keys are deterministic, so a retry overwrites in
//     place. Re-running after a partial failure is the supported recovery.
//   - Per-object failures don't abort the batch; they come back in failed[].
async function handleCopyToSolar(event, cors, customerId) {
  if (!customerId || !/^[a-zA-Z0-9]{15,18}$/.test(customerId)) {
    return jsonResponse(400, cors, {
      error: "invalid_record_id",
      code: "INVALID_RECORD_ID",
      message: "Path must carry a Salesforce Customer record id.",
    });
  }

  // Auth — tenant derived ONLY from the verified token.
  let identity;
  try {
    identity = await resolveIdentity(event.__authHeader);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return jsonResponse(m.status, cors, m.body);
    throw err;
  }
  const tenantId = identity.tenantId;
  if (!tenantId) {
    return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
  }

  // 1) Load the customer TENANT-SCOPED and read the link. Missing or cross-tenant
  //    are indistinguishable -> 404.
  const soql =
    `SELECT Id, ${SOLAR_LINK_FIELD} FROM ${CUSTOMER_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(customerId)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' ` +
    `LIMIT 1`;
  const rows = await sfQuery(soql);
  if (!rows || rows.length === 0) {
    return jsonResponse(404, cors, {
      error: "not_found",
      code: "RECORD_NOT_FOUND",
    });
  }
  const solarRecordId = String(rows[0][SOLAR_LINK_FIELD] || "").trim();
  if (!solarRecordId) {
    return jsonResponse(400, cors, {
      error: "no_linked_project",
      code: "NO_LINKED_PROJECT",
      message:
        "This customer has no Linked_Solar_Project__c, so there is nowhere to copy files to. Create the Solar project first.",
    });
  }

  // The link should always point inside the tenant; verify anyway (fail closed)
  // so a bad data fix-up can never write files into another tenant's folder.
  const solarOwned = await assertTenantOwnsRecord(solarRecordId, "solar", tenantId);
  if (!solarOwned) {
    console.error(
      `copy-to-solar: customer ${customerId} links to solar ${solarRecordId} outside tenant ${tenantId}`
    );
    return jsonResponse(400, cors, {
      error: "linked_project_not_accessible",
      code: "LINKED_PROJECT_NOT_ACCESSIBLE",
    });
  }

  // 2) Server-side copy. Zero files is a success, not an error.
  const { copied, failed } = await copyRecordFiles(s3, customerId, solarRecordId);

  // 3) Register the copies in Supabase file metadata. The DEPLOYED Files tab lists
  //    straight from S3, so the files are already visible without this; it exists to
  //    match the documented metadata-backed design (D-029) and mirrors what the
  //    budget snapshot does. STRICTLY BEST-EFFORT — the bytes are already in place,
  //    so a metadata failure must not fail the copy.
  let metadataRegistered = 0;
  if (copied.length > 0) {
    try {
      const supabase = await getSupabaseClient();
      for (const f of copied) {
        try {
          await registerFileMetadata(supabase, {
            s3Key: f.key,
            fileName: f.fileName,
            // Same value the budget snapshot writer uses: the Client__c record id.
            tenantId: tenantId,
            sfRecordId: solarRecordId,
            sfObjectType: SOLAR_SF_OBJECT,
            uploadedByUserId: identity?.user?.id ?? null,
            uploadedByUserName: "Sundial (copied from Customer)",
            fileSizeBytes: f.size,
            mimeType: null, // S3 listing doesn't carry it; not worth a HEAD per file
            category: "Copied from Customer",
            subfolder: null,
          });
          metadataRegistered++;
        } catch (e) {
          console.error(
            `copy-to-solar: metadata register failed for ${f.key}: ${e?.message || e}`
          );
        }
      }
    } catch (e) {
      console.error(
        `copy-to-solar: supabase unavailable, skipping metadata: ${e?.message || e}`
      );
    }
  }

  // publicUrl is deliberately NOT returned: the caller already sees these files on
  // the customer, and this response shouldn't hand out solar-prefixed links (the
  // TEMP Sales Rep solar-files restriction below guards those).
  return jsonResponse(200, cors, {
    customerId,
    solarRecordId,
    copied: copied.length,
    failedCount: failed.length,
    files: copied.map((f) => ({ fileName: f.fileName, key: f.key, size: f.size })),
    failed,
    metadataRegistered,
  });
}

export const handler = async (event) => {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  // POST route: copy the customer's files into the linked Solar project.
  if (method === "POST") {
    const copyCustomerId = extractCopyToSolarCustomerId(event);
    if (copyCustomerId === null) {
      return jsonResponse(404, cors, {
        error: "not_found",
        code: "ROUTE_NOT_FOUND",
      });
    }
    try {
      // Pass the normalized auth header through rather than re-normalizing.
      event.__authHeader = headers["authorization"];
      return await handleCopyToSolar(event, cors, copyCustomerId);
    } catch (err) {
      console.error("copy-to-solar error:", err?.message || String(err));
      return jsonResponse(500, cors, { error: "server_error" });
    }
  }

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

    // ACCESS MODEL (D-064 §3.6). This REPLACES the TEMP Sales-Rep solar-files 403
    // that stood here from 2026-08-03. Two differences that matter:
    //
    //   1. It keys on the CALLER's resolved scope, not on a hierarchy string. The
    //      TEMP version let any role it did not recognise through, which is how a
    //      Technician could list any record's files.
    //   2. It also gates CUSTOMER files, on the RECORD. The TEMP version allowed
    //      customer files to every rep for every customer in the tenant — 31,653 of
    //      them — because it only ever asked about the object, never the record.
    const access = alwaysEnforcedAccess(identity);
    const denied = await assertActionOnRecord(
      `files.${objectKey}.list`,
      objectKey,
      recordId,
      access
    );
    if (denied) return jsonResponse(denied.status, cors, denied.body);

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
