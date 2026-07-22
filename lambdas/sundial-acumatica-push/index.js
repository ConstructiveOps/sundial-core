// sundial-acumatica-push — LAYER 1 of the Acumatica integration.
//
// Creates a Customer and a Project (from a template) in Acumatica ERP from a
// Sundial_Customer__c record and its linked Sundial_Solar__c project. This is the
// "customer + project shell" layer ONLY. Budget values, project attributes, POs,
// and project activation are LATER layers and are deliberately NOT built here.
//
// Handles:
//   POST /acumatica/push   body { "recordId": "<Sundial_Customer__c Id>" }
//
// AUTH + TENANT ISOLATION (mirrors sf-query / sf-update): the caller is a signed-
// in portal user; resolveIdentity verifies the Supabase token and yields the
// tenant (Client__c). NO request input can set/override the tenant. Every
// Salesforce read/write filters Client__c = '<tenantId>'. Runs for the harmon
// tenant like the other Lambdas.
//
// TWO-STAGE IDEMPOTENCY (never duplicate ERP records):
//   CUSTOMER — driven by Acumatica_Customer_ID__c on the customer record.
//     populated -> customer exists, reuse it, skip create.
//     empty     -> create in Acumatica, THEN write back BOTH Acumatica_Customer_ID__c
//                  (CustomerID string) and Acumatica_Customer_GUID__c (id GUID).
//   PROJECT  — driven by Project_Created_in_Acumatica__c on the linked solar record.
//     set   -> project exists, skip create.
//     empty -> create in Acumatica (keyed by the manually-set Acumatica_Project_ID__c),
//              THEN stamp Project_Created_in_Acumatica__c = today.
//   FINALIZE — once BOTH stages are confirmed done, set Synced_to_Acumatica__c = true.
//
// FAIL-SAFE ORDERING: each Acumatica create must SUCCEED before its Salesforce
// write-back. A failure leaves the corresponding flag UNSET so a retry resumes:
//   - the customer-ID check prevents re-creating the customer, and
//   - the project-date check prevents re-creating the project (and the project is
//     keyed by ProjectID, so even a re-PUT updates rather than duplicates).
// The one irreducible risk is "Acumatica customer created but SF write-back
// failed": the customer id is NOT yet on the record, so a blind retry WOULD make
// a second customer. We therefore return that case as a loud, non-retry-safe
// result carrying the created CustomerID/GUID for manual reconcile — never a bare
// 5xx that invites an automatic retry.
//
// Value-safety: never logs or returns tokens, secrets, passwords, or key material.

import { getSalesforceToken, sfQuery, soqlEscapeString } from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import { putAcumaticaEntity } from "../../lib/acumatica.js";
import { lookupTaxZone } from "../../lib/acumatica-tax-zones.js";

const SF_API_VERSION = "v60.0";
const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";

// Hardcoded for Layer 1 (all pushes are residential solar customers).
const CUSTOMER_CLASS = "RESIDENT";

// Project template lookup: Sundial project type -> Acumatica ProjectTemplateID.
// Layer 1 always uses residential solar ("RS"); the map is the extension point
// so Roofing/Commercial templates can be added later without changing the flow.
const PROJECT_TEMPLATE_MAP = {
  residential_solar: "RS",
};
const DEFAULT_PROJECT_TYPE = "residential_solar";
function resolveProjectTemplate(projectType) {
  return PROJECT_TEMPLATE_MAP[projectType] ?? PROJECT_TEMPLATE_MAP[DEFAULT_PROJECT_TYPE];
}

// Customer fields read from Salesforce (per the Layer 1 spec).
const CUSTOMER_FIELDS = [
  "Id",
  "Name",
  "Primary_Email__c",
  "Primary_Phone__c",
  "City__c",
  "Acumatica_Project_ID__c",
  "Acumatica_Customer_ID__c",
  "Acumatica_Customer_GUID__c",
  "Synced_to_Acumatica__c",
  "Description__c",
  "Linked_Solar_Project__c",
  "Client__c",
];

// --- CORS (mirrors the other Lambdas; this route is POST/OPTIONS) -----------
const STATIC_ALLOWED_ORIGINS = new Set(["http://localhost:5173"]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (
      u.protocol === "https:" &&
      (u.hostname === "vercel.app" || u.hostname.endsWith(".vercel.app"))
    ) {
      return true;
    }
  } catch {
    /* not parseable -> disallowed */
  }
  return false;
}

function corsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : "http://localhost:5173";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function normalizeHeaders(rawHeaders) {
  const out = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) out[k.toLowerCase()] = v;
  }
  return out;
}

function jsonResponse(statusCode, cors, bodyObj) {
  return {
    statusCode,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}

// Same identity-error -> HTTP mapping the other Lambdas use.
function mapIdentityError(code) {
  switch (code) {
    case "AUTH_NO_TOKEN":
    case "AUTH_INVALID_TOKEN":
      return { status: 401, body: { error: "unauthorized", code } };
    case "NO_SUNDIAL_USER":
      return { status: 403, body: { error: "no_portal_user", code: "NO_SUNDIAL_USER" } };
    case "USER_INACTIVE":
      return { status: 403, body: { error: "inactive_user", code: "USER_INACTIVE" } };
    default:
      return null;
  }
}

// --- Body parsing (base64-aware, like sf-update) ---------------------------
function parseBody(event) {
  let raw = event?.body;
  if (raw != null && typeof raw === "object") return raw;
  if (raw == null) return null;
  if (event?.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  raw = String(raw).trim();
  if (raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- Small helpers ---------------------------------------------------------
function cleanStr(v) {
  return v == null ? "" : String(v).trim();
}
function orNull(v) {
  const s = cleanStr(v);
  return s === "" ? null : s;
}
// Acumatica contract-based REST wraps every field value as { value: ... }.
function av(x) {
  return { value: x };
}
// Today's date as YYYY-MM-DD for a Salesforce date field.
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}
// Extract a concise Acumatica error message without dumping an HTML page.
function acuMessage(res) {
  const m =
    res?.data?.exceptionMessage ||
    res?.data?.message ||
    (typeof res?.text === "string" ? res.text.slice(0, 500) : null);
  return m || `Acumatica returned status ${res?.status}`;
}

// --- Salesforce write (REST PATCH) with one 401 refresh/retry --------------
// Same mechanism sundial-sf-update uses under the hood. The record was proven
// in-tenant by the tenant-scoped read before any PATCH, so patching by Id is safe.
async function sfPatch(sfObject, id, fieldsObj) {
  async function run(forceRefresh) {
    const { access_token, instance_url } = await getSalesforceToken({ forceRefresh });
    return fetch(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${sfObject}/${encodeURIComponent(
        id
      )}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fieldsObj),
      }
    );
  }
  let resp = await run(false);
  if (resp.status === 401) resp = await run(true);
  return resp;
}

// --- handler ---------------------------------------------------------------
export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "";
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (method !== "POST") {
    return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });
  }

  // Running summary of what ran vs skipped; included in every response so a
  // partial failure clearly reports what WAS and WASN'T completed.
  const summary = {
    recordId: null,
    customer: { stage: null, acumaticaCustomerId: null, acumaticaCustomerGuid: null },
    project: { stage: null, projectId: null, templateId: null },
    finalize: { synced: false },
    warnings: [],
  };

  // Helper: a stage failure -> structured error naming the failed stage + summary.
  function stageFailure(httpStatus, failedStage, message, extra = {}) {
    return jsonResponse(httpStatus, cors, {
      ok: false,
      failedStage,
      message,
      summary,
      ...extra,
    });
  }

  try {
    // --- Input validation ---------------------------------------------------
    const body = parseBody(event);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse(400, cors, {
        error: "invalid_body",
        code: "INVALID_BODY",
        message: 'Expected JSON { "recordId": "<Sundial_Customer__c Id>" }.',
      });
    }
    const recordId = cleanStr(body.recordId);
    if (!/^[a-zA-Z0-9]{15,18}$/.test(recordId)) {
      return jsonResponse(400, cors, {
        error: "invalid_record_id",
        code: "INVALID_RECORD_ID",
        message: "recordId must be a Salesforce record id.",
      });
    }
    summary.recordId = recordId;

    // --- Auth: tenant derived ONLY from the verified token ------------------
    let identity;
    try {
      identity = await resolveIdentity(headers["authorization"]);
    } catch (err) {
      const mapped = mapIdentityError(err?.code);
      if (mapped) return jsonResponse(mapped.status, cors, mapped.body);
      throw err;
    }
    const tenantId = identity.tenantId;
    if (!tenantId) {
      return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    }

    // --- Read the customer, TENANT-SCOPED (Id + Client__c) ------------------
    const custSoql =
      `SELECT ${CUSTOMER_FIELDS.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(recordId)}' ` +
      `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`;
    const custRecords = await sfQuery(custSoql);
    if (!custRecords || custRecords.length === 0) {
      return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
    }
    const cust = custRecords[0];

    // =====================================================================
    // STAGE 1 — CUSTOMER
    // =====================================================================
    let acuCustomerId = cleanStr(cust.Acumatica_Customer_ID__c);
    let acuCustomerGuid = orNull(cust.Acumatica_Customer_GUID__c);

    if (acuCustomerId) {
      // Already in Acumatica -> reuse, skip creation.
      summary.customer.stage = "skipped_exists";
    } else {
      const customerName = cleanStr(cust.Name);
      if (!customerName) {
        return stageFailure(
          400,
          "customer_create",
          "Name is required to create an Acumatica customer."
        );
      }
      const email = orNull(cust.Primary_Email__c);
      const phone = orNull(cust.Primary_Phone__c);

      // Tax zone from City__c; OMIT when unmatched (never guess), and warn.
      const city = cleanStr(cust.City__c);
      const { zone, matched } = lookupTaxZone(city);
      if (city && !matched) {
        console.warn(`acumatica-push: tax zone unmatched for city "${city}" — TaxZone omitted.`);
        summary.warnings.push({ code: "tax_zone_unmatched", city });
      }

      // Build the Acumatica customer body (omit empty optional fields).
      const customerBody = {
        CustomerName: av(customerName),
        CustomerClass: av(CUSTOMER_CLASS),
      };
      if (email) customerBody.Email = av(email);
      const mainContact = {};
      if (phone) mainContact.Phone1 = av(phone);
      if (email) mainContact.Email = av(email);
      if (Object.keys(mainContact).length > 0) customerBody.MainContact = mainContact;
      if (zone) customerBody.TaxZone = av(zone);

      // CREATE in Acumatica. Nothing is written to Salesforce until this succeeds.
      const custRes = await putAcumaticaEntity("Customer", customerBody);
      if (!custRes.ok) {
        console.error(
          `acumatica-push: customer create failed (${custRes.status}) for ${recordId}: ${custRes.text?.slice(0, 800)}`
        );
        // Nothing created -> retry-safe -> 502.
        return stageFailure(502, "customer_create", acuMessage(custRes), {
          acumaticaStatus: custRes.status,
        });
      }
      acuCustomerId = cleanStr(custRes.data?.CustomerID?.value);
      acuCustomerGuid = orNull(custRes.data?.id);
      if (!acuCustomerId) {
        console.error(
          `acumatica-push: customer create returned no CustomerID for ${recordId}: ${custRes.text?.slice(0, 800)}`
        );
        return stageFailure(502, "customer_create", "Acumatica response contained no CustomerID.");
      }

      summary.customer.stage = "created";

      // WRITE BACK both ids. If this fails the customer EXISTS in Acumatica but SF
      // doesn't know -> NOT retry-safe (a retry would create a duplicate). Surface
      // loudly (200 ok:false) with the ids so they are not lost; do not 5xx.
      const patch = await sfPatch(CUSTOMER_SF_OBJECT, cust.Id, {
        Acumatica_Customer_ID__c: acuCustomerId,
        Acumatica_Customer_GUID__c: acuCustomerGuid,
      });
      if (!patch.ok) {
        const pText = await patch.text();
        console.error(
          `acumatica-push: customer write-back failed (${patch.status}) for ${recordId}, CustomerID ${acuCustomerId}: ${pText?.slice(0, 800)}`
        );
        summary.customer.acumaticaCustomerId = acuCustomerId;
        summary.customer.acumaticaCustomerGuid = acuCustomerGuid;
        return stageFailure(
          200,
          "customer_writeback",
          "Acumatica customer was CREATED but the Salesforce write-back failed. " +
            "Set Acumatica_Customer_ID__c on the customer record to this CustomerID " +
            "before retrying, or a duplicate customer will be created.",
          { acumaticaCustomerId: acuCustomerId, acumaticaCustomerGuid: acuCustomerGuid }
        );
      }
    }
    summary.customer.acumaticaCustomerId = acuCustomerId;
    summary.customer.acumaticaCustomerGuid = acuCustomerGuid;

    // =====================================================================
    // STAGE 2 — PROJECT (requires the linked solar record)
    // =====================================================================
    const linkedSolarId = cleanStr(cust.Linked_Solar_Project__c);
    if (!linkedSolarId) {
      return stageFailure(
        200,
        "project",
        "Customer has no Linked_Solar_Project__c; cannot create the Acumatica project (Layer 1 requires a linked residential solar project)."
      );
    }

    // Read the linked solar record, TENANT-SCOPED.
    const solarSoql =
      `SELECT Id, Project_Created_in_Acumatica__c, Client__c FROM ${SOLAR_SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(linkedSolarId)}' ` +
      `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`;
    const solarRecords = await sfQuery(solarSoql);
    if (!solarRecords || solarRecords.length === 0) {
      return stageFailure(
        200,
        "project",
        "Linked solar project not found for this tenant."
      );
    }
    const solar = solarRecords[0];

    const projectAlreadyCreated = cleanStr(solar.Project_Created_in_Acumatica__c) !== "";
    const projectId = cleanStr(cust.Acumatica_Project_ID__c);
    const templateId = resolveProjectTemplate(DEFAULT_PROJECT_TYPE);
    summary.project.templateId = templateId;

    if (projectAlreadyCreated) {
      // Already in Acumatica -> skip create.
      summary.project.stage = "skipped_exists";
      summary.project.projectId = projectId || null;
    } else {
      // ProjectID is set MANUALLY by Harmon before sync; we must supply it (do not
      // let Acumatica auto-number). Absent -> cannot create.
      if (!projectId) {
        return stageFailure(
          200,
          "project_create",
          "Acumatica_Project_ID__c is not set on the customer record; Harmon must set it before sync."
        );
      }

      const description = orNull(cust.Description__c);
      const projectBody = {
        ProjectID: av(projectId),
        ProjectTemplateID: av(templateId), // template auto-scaffolds tasks + budget
        Customer: av(acuCustomerId),
      };
      if (description) projectBody.Description = av(description);

      // CREATE in Acumatica. Keyed by ProjectID, so a retry re-PUTs the SAME
      // project (update) rather than duplicating. Comes back "In Planning"/Hold —
      // expected; activation is a later layer, not attempted here.
      const projRes = await putAcumaticaEntity("Project", projectBody);
      if (!projRes.ok) {
        console.error(
          `acumatica-push: project create failed (${projRes.status}) for ${recordId}, ProjectID ${projectId}: ${projRes.text?.slice(0, 800)}`
        );
        // Nothing to stamp; retry-safe (customer already linked, project keyed by ID).
        return stageFailure(502, "project_create", acuMessage(projRes), {
          acumaticaStatus: projRes.status,
        });
      }
      const returnedProjectId = cleanStr(projRes.data?.ProjectID?.value) || projectId;
      summary.project.projectId = returnedProjectId;

      // STAMP the date. Failure here is retry-safe (re-PUT updates the same
      // project by ProjectID), but the stage is not "done" until stamped.
      const solarPatch = await sfPatch(SOLAR_SF_OBJECT, solar.Id, {
        Project_Created_in_Acumatica__c: todayDate(),
      });
      if (!solarPatch.ok) {
        const spText = await solarPatch.text();
        console.error(
          `acumatica-push: project write-back failed (${solarPatch.status}) for solar ${solar.Id}, ProjectID ${returnedProjectId}: ${spText?.slice(0, 800)}`
        );
        summary.project.stage = "created";
        return stageFailure(
          200,
          "project_writeback",
          "Acumatica project was CREATED but stamping Project_Created_in_Acumatica__c failed. " +
            "Re-running is safe (the project is keyed by ProjectID and will be updated, not duplicated).",
          { projectId: returnedProjectId }
        );
      }
      summary.project.stage = "created";
    }

    // =====================================================================
    // STAGE 3 — FINALIZE (both stages confirmed done)
    // =====================================================================
    if (cust.Synced_to_Acumatica__c === true) {
      summary.finalize.synced = true;
    } else {
      const finalPatch = await sfPatch(CUSTOMER_SF_OBJECT, cust.Id, {
        Synced_to_Acumatica__c: true,
      });
      if (!finalPatch.ok) {
        const fText = await finalPatch.text();
        console.error(
          `acumatica-push: finalize write-back failed (${finalPatch.status}) for ${recordId}: ${fText?.slice(0, 800)}`
        );
        return stageFailure(
          200,
          "finalize_writeback",
          "Customer and project are complete in Acumatica but setting Synced_to_Acumatica__c failed. " +
            "Re-running is safe (both stages will be skipped) and will set the flag."
        );
      }
      summary.finalize.synced = true;
    }

    // --- SUCCESS ------------------------------------------------------------
    return jsonResponse(200, cors, { ok: true, ...summary });
  } catch (err) {
    // Salesforce query/DML errors (from lib/salesforce.js sfQuery/sfWrite) carry
    // the raw SF response on err.sfStatus / err.sfBody. Log that body — it names
    // the exact field/clause Salesforce rejected (e.g. INVALID_FIELD "No such
    // column 'Foo__c' on entity 'Sundial_Customer__c'"). These messages are
    // business-level, not sensitive, so we also surface them in the response to
    // make direct-invoke debugging possible.
    if (err?.sfStatus != null) {
      console.error(
        `acumatica-push Salesforce error (${err.sfStatus}):`,
        err.sfBody || "(no response body)"
      );
      let messages = null;
      try {
        const parsed = JSON.parse(err.sfBody);
        if (Array.isArray(parsed)) {
          messages = parsed
            .map((e) => (e?.errorCode ? `${e.errorCode}: ${e.message}` : e?.message))
            .filter(Boolean);
        }
      } catch {
        /* non-JSON body -> fall back to err.message below */
      }
      return jsonResponse(502, cors, {
        error: "salesforce_error",
        code: "SF_REQUEST_FAILED",
        status: err.sfStatus,
        messages: messages && messages.length ? messages : [err.message],
      });
    }
    console.error("acumatica-push unexpected error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
