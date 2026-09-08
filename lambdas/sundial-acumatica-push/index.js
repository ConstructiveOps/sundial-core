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
import { alwaysEnforcedAccess, assertAction } from "../../lib/access-enforce.js";
import {
  putAcumaticaEntity,
  getAcumaticaEntity,
  normalizeAcumaticaPhone,
} from "../../lib/acumatica.js";
import { lookupTaxZone } from "../../lib/acumatica-tax-zones.js";
import {
  verifyAttributeWrite,
  JOBTYPE_ATTRIBUTE_ID,
  JOBTYPE_VALUE,
} from "../../lib/acumatica-attributes.js";
import {
  normalizePicklist,
  resolveProjectManager,
  PROJECT_MANAGER_EMPLOYEE_IDS,
  PROJECT_MANAGER_FIELD,
} from "../../lib/acumatica-project-manager.js";

const SF_API_VERSION = "v60.0";
const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";

// Hardcoded for Layer 1 (all pushes are residential solar customers).
const CUSTOMER_CLASS = "RESIDENT";

// ===========================================================================
// SHARED PICKLIST + PROJECT-MANAGER MAPS
// ===========================================================================
// `normalizePicklist` (the dash-folding matcher) and the project-manager name map moved
// to lib/ when the budget push started writing ProjectManager too. Both Lambdas write the
// same Acumatica field, and two copies of a name map eventually become two different name
// maps — see the module header there. Re-exported so this Lambda's callers and tests keep
// one import site.
export {
  normalizePicklist,
  resolveProjectManager,
  PROJECT_MANAGER_EMPLOYEE_IDS,
  PROJECT_MANAGER_FIELD,
};


// ===========================================================================
// B. PARENT ACCOUNT (Billing tab) BY FINANCING PARTNER
// ===========================================================================
/**
 * `Sundial_Customer__c.Financing_Partner__c` -> Acumatica `ParentRecord` (CustomerID).
 *
 *   Participate Prepaid Lease - Cash        -> C001310754   Participate Holdings LLC
 *   Participate Prepaid Lease - Financed    -> C001310754   Participate Holdings LLC
 *   Lightreach                              -> C001308357   LIghtReach/Palmetto
 *   Credit Human                            -> 01868        Credit Human
 *   Cash, blank, anything else              -> no parent account at all
 *
 * All three targets were read back from the live tenant 2026-09-08 and are Active
 * RESIDENT accounts; `LIghtReach/Palmetto` really is spelled with that capital I in
 * Acumatica, which is why the name is recorded here rather than trusted to memory.
 *
 * Keys are stored already-normalised (see normalizePicklist) so the en-dash value and
 * the hyphen value both land on the same entry.
 *
 * A financing partner that is neither blank, nor "Cash", nor listed gets NO parent and
 * a summary warning. That is the point of the warning: Harmon adds finance partners,
 * and a new one must surface as "nobody taught Sundial where this one belongs" rather
 * than as a customer that quietly billed to the wrong place — or to nowhere.
 */
export const FINANCING_PARTNER_PARENT_ACCOUNTS = Object.freeze({
  [normalizePicklist("Participate Prepaid Lease - Cash")]: "C001310754",
  [normalizePicklist("Participate Prepaid Lease - Financed")]: "C001310754",
  [normalizePicklist("Lightreach")]: "C001308357",
  [normalizePicklist("Credit Human")]: "01868",
});

/**
 * Financing partners that deliberately have no parent account, so they do not warn.
 * "Cash" is a real, common, correct answer (256 records) — warning on it every time
 * would train everyone to ignore the warning that matters.
 */
export const FINANCING_PARTNERS_WITHOUT_PARENT = Object.freeze(
  new Set([normalizePicklist("Cash")])
);

/**
 * @returns {{parentAccount: string|null, unlisted: boolean}}
 *   parentAccount - the Acumatica CustomerID to set as ParentRecord, or null for none
 *   unlisted      - a non-blank partner that is neither mapped nor known-parentless
 */
export function resolveParentAccount(financingPartner) {
  const key = normalizePicklist(financingPartner);
  if (key === "") return { parentAccount: null, unlisted: false };
  const parentAccount = FINANCING_PARTNER_PARENT_ACCOUNTS[key] ?? null;
  if (parentAccount) return { parentAccount, unlisted: false };
  return { parentAccount: null, unlisted: !FINANCING_PARTNERS_WITHOUT_PARENT.has(key) };
}

// ===========================================================================
// A. CUSTOMER ADDRESS
// ===========================================================================
/**
 * Acumatica stores US states as the two-letter USPS code — `"AZ"`, not
 * `"AZ - ARIZONA"`. Verified 2026-09-08 by reading 39 customers created since
 * 2026-08-20: 35 `"AZ"`, 1 `"MA"`, and `Country` `"US"` on all 39. The Salesforce side
 * already matches — `Sundial_Customer__c.State__c` holds `"AZ"` (21,797), `"OK"`
 * (1,687), `"FL"` (102) and so on, two-letter throughout — so this is a validation, not
 * a translation.
 *
 * The list is the USPS set rather than an enumeration of Acumatica's own states,
 * because the `Default/25.200.001` endpoint exposes no `State` entity to enumerate.
 * That is the reason the fallback exists and warns: a code Acumatica happens not to
 * accept would 422 the entire customer create, and losing a customer over a state code
 * is worse than filing an out-of-state job under AZ and saying so out loud.
 */
export const US_STATE_CODES = Object.freeze(
  new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
    "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
    "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "AS", "GU", "MP", "PR", "VI",
  ])
);

/** Harmon is a Phoenix company; an unusable state code files the job at home. */
export const DEFAULT_STATE = "AZ";

/** Every Sundial customer is domestic. Sent unconditionally, never derived. */
export const CUSTOMER_COUNTRY = "US";

/**
 * @returns {{state: string, fellBack: boolean}} — `state` is always sent.
 */
export function resolveCustomerState(raw) {
  const code = String(raw ?? "").trim().toUpperCase();
  if (US_STATE_CODES.has(code)) return { state: code, fellBack: false };
  return { state: DEFAULT_STATE, fellBack: true };
}

/**
 * Build the Acumatica `MainContact.Address` block from the Salesforce address fields.
 *
 * OMIT-EMPTY, matching the body style already used for Email/Phone1/TaxZone: a blank
 * street or postal code is left out entirely rather than sent as `""`, so a push can
 * never blank an address someone completed in Acumatica by hand. State and Country are
 * the exception — both are always sent, because both always have a defensible value.
 *
 * The read path needs `$expand=MainContact,MainContact/Address` to see this back; the
 * write path just nests it, which is how it is written here.
 */
export function buildCustomerAddress(cust) {
  const street = orNull(cust?.Street__c);
  const city = orNull(cust?.City__c);
  const postalCode = orNull(cust?.Postal_Code__c);
  const { state, fellBack } = resolveCustomerState(cust?.State__c);

  const address = { State: av(state), Country: av(CUSTOMER_COUNTRY) };
  if (street) address.AddressLine1 = av(street);
  if (city) address.City = av(city);
  if (postalCode) address.PostalCode = av(postalCode);
  return { address, stateFellBack: fellBack, rawState: cleanStr(cust?.State__c) };
}

// ===========================================================================
// C. PROJECT MANAGER + JOBTYPE — both now shared with the budget push
// ===========================================================================
// `resolveProjectManager` + the name map live in lib/acumatica-project-manager.js and
// `JOBTYPE_ATTRIBUTE_ID` / `JOBTYPE_VALUE` in lib/acumatica-attributes.js, imported at the
// top of this file. They moved out of here on 2026-09-08 when the budget push began
// refreshing the same two things on every push (ADR D-070): Layer-1 sets them at create,
// when a project manager is often not assigned yet, and the budget push is the only thing
// that ever revisits them. One definition each, because the way two copies drift apart is
// silent — a job created under one spelling and refreshed under the other would simply
// stop having a manager, and nothing would report it.

// Project template lookup: Sundial project type -> Acumatica ProjectTemplateID.
// RS and RSDC differ by exactly one budget line — DCREBATE | BILLING | <N/A> | Income —
// so the template choice IS the decision about whether the $0.45/W domestic-content
// rebate has anywhere to land. The map stays the extension point so Roofing/Commercial
// templates can be added later without changing the flow.
const PROJECT_TEMPLATE_MAP = {
  residential_solar: "RS",
  residential_solar_dc: "RSDC",
};
const DEFAULT_PROJECT_TYPE = "residential_solar";
function resolveProjectTemplate(projectType) {
  return PROJECT_TEMPLATE_MAP[projectType] ?? PROJECT_TEMPLATE_MAP[DEFAULT_PROJECT_TYPE];
}

/**
 * Domestic Content election — the SINGLE source of truth for both the Acumatica
 * template (RS vs RSDC) and the budget calc's DC rebate line.
 *
 * SOURCE FIELD: `Sundial_Customer__c.Domestic_Content_Eligible__c`, a Yes/No picklist.
 * Per the business owner, "eligible" IS the election: Yes means RSDC template AND a
 * non-zero DC_Rebate_Amount__c; anything else (No, blank, null) means RS and zero.
 *
 * It is a picklist, so ONLY "Yes" wins — trimmed and case-insensitive to survive a
 * value-label edit, but deliberately NOT permissive about other affirmative spellings.
 * The budget calc's isDomesticContent() implements the identical rule against the
 * identical field; if these two ever disagree the budget push aborts on the DCREBATE
 * row (non-zero rebate on an RS scaffold), which is the failure this pairing prevents.
 */
function isDomesticContentEligible(cust) {
  const raw = cust?.Domestic_Content_Eligible__c;
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === "yes";
}

// Customer fields read from Salesforce (per the Layer 1 spec).
const CUSTOMER_FIELDS = [
  "Id",
  "Name",
  "Primary_Email__c",
  "Primary_Phone__c",
  // Address, written to MainContact.Address on NEW customers only (item A).
  // City__c does double duty: it also drives the tax-zone lookup.
  "Street__c",
  "City__c",
  "State__c",
  "Postal_Code__c",
  // Drives ParentRecord on the Billing tab (see FINANCING_PARTNER_PARENT_ACCOUNTS).
  "Financing_Partner__c",
  "Acumatica_Project_ID__c",
  "Acumatica_Customer_ID__c",
  "Acumatica_Customer_GUID__c",
  "Synced_to_Acumatica__c",
  "Description__c",
  "Linked_Solar_Project__c",
  "Client__c",
  // Drives RS vs RSDC template selection (see isDomesticContentEligible above).
  "Domestic_Content_Eligible__c",
];

// --- CORS (mirrors the other Lambdas; this route is POST/OPTIONS) -----------
const STATIC_ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "https://sundial.harmonelectric.net",
]);

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

/**
 * Re-read a just-created project and prove the JOBTYPE attribute and the project
 * manager actually landed.
 *
 * Never throws and never fails the push: it appends warnings and sets
 * `summary.project.attributesVerified`. `null` there means "we could not tell"
 * (the re-read itself failed), which is deliberately distinct from `false`.
 *
 * @param {string} projectId
 * @param {{attributes: Array<{AttributeID: {value: string}, Value: {value: string}}>,
 *          expectedManager: string|null, summary: object, recordId: string}} opts
 */
export async function verifyProjectExtras(projectId, opts) {
  const { attributes = [], expectedManager = null, summary, recordId } = opts;
  const sent = attributes.map((a) => ({
    AttributeID: a?.AttributeID?.value,
    Value: a?.Value?.value,
  }));

  let after;
  try {
    after = await getAcumaticaEntity("Project", {
      $filter: `ProjectID eq '${String(projectId).replace(/'/g, "''")}'`,
      $expand: "Attributes,ProjectProperties",
    });
  } catch (err) {
    after = { ok: false, status: null, text: err?.message || String(err) };
  }
  if (!after.ok) {
    console.warn(
      `acumatica-push: project ${projectId} was created but the verifying re-read failed ` +
        `(${after.status}) for ${recordId} — cannot say whether JOBTYPE landed.`
    );
    summary.project.attributesVerified = null;
    summary.warnings.push({ code: "project_verify_read_failed", status: after.status ?? null });
    return;
  }

  const project = (Array.isArray(after.data) ? after.data : [after.data])[0];
  const check = verifyAttributeWrite(sent, project?.Attributes);
  summary.project.attributesVerified = check.ok;
  if (!check.ok) {
    const detail =
      (check.missing.length ? `discarded: ${check.missing.join(", ")}` : "") +
      (check.mismatched.length
        ? `${check.missing.length ? " | " : ""}holding something else: ${check.mismatched
            .map((m) => `${m.attributeId}=${JSON.stringify(m.got)} (sent ${JSON.stringify(m.sent)})`)
            .join("; ")}`
        : "");
    console.error(
      `acumatica-push: JOBTYPE UNVERIFIED on project ${projectId} for ${recordId} — ${detail}`
    );
    summary.warnings.push({
      code: "project_attributes_unverified",
      missing: check.missing,
      mismatched: check.mismatched,
    });
  }

  if (expectedManager) {
    const got = cleanStr(project?.ProjectProperties?.ProjectManager?.value);
    if (got !== expectedManager) {
      console.error(
        `acumatica-push: ProjectManager UNVERIFIED on project ${projectId} for ${recordId} — ` +
          `sent ${expectedManager}, read back ${JSON.stringify(got || null)}.`
      );
      summary.warnings.push({
        code: "project_manager_unverified",
        sent: expectedManager,
        got: got || null,
      });
    }
  }
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
    customer: {
      stage: null,
      acumaticaCustomerId: null,
      acumaticaCustomerGuid: null,
      parentAccount: null,
      financingPartner: null,
      state: null,
    },
    project: {
      stage: null,
      projectId: null,
      templateId: null,
      domesticContentEligible: null,
      projectManager: null,
      jobType: null,
      attributesVerified: null,
    },
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

    // ACCESS MODEL (D-064 §3.6): pushing a customer into Acumatica is an accounting
    // action, tenant scope only. No record check is needed beyond the action gate —
    // a sales role cannot perform it on ANY record, so there is nothing to scope.
    {
      const denied = assertAction("acumatica.sync", alwaysEnforcedAccess(identity));
      if (denied) return jsonResponse(denied.status, cors, denied.body);
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

      // Acumatica enforces the `(999) 999-9999` input mask SERVER-SIDE and rejects the
      // whole customer with a 422 when it does not match. Salesforce imposes no phone
      // format, so a raw value like "623 703-2778" fails — which is exactly what killed
      // a real production Create Project. Same behaviour as the tax zone below: send a
      // value only when it is certainly valid, otherwise OMIT AND WARN rather than
      // guessing or failing the whole push over a phone number.
      const rawPhone = orNull(cust.Primary_Phone__c);
      const { phone, extension, reason: phoneReason } = normalizeAcumaticaPhone(rawPhone);
      if (rawPhone && !phone) {
        console.warn(
          `acumatica-push: phone "${rawPhone}" not usable for the Acumatica mask ` +
            `(${phoneReason}) — Phone1 omitted for ${recordId}.`
        );
        summary.warnings.push({ code: "phone_unusable", value: rawPhone, reason: phoneReason });
      }
      // Phone1 has no extension slot, so an extension cannot be sent. Say so rather
      // than dropping it silently — it is a real piece of the ops record.
      if (extension) {
        console.warn(
          `acumatica-push: dropped extension "${extension}" from phone for ${recordId} ` +
            `(Acumatica Phone1 has no extension field).`
        );
        summary.warnings.push({ code: "phone_extension_dropped", extension });
      }

      // Tax zone from City__c; OMIT when unmatched (never guess), and warn.
      const city = cleanStr(cust.City__c);
      const { zone, matched } = lookupTaxZone(city);
      if (city && !matched) {
        console.warn(`acumatica-push: tax zone unmatched for city "${city}" — TaxZone omitted.`);
        summary.warnings.push({ code: "tax_zone_unmatched", city });
      }

      // ADDRESS (item A). NEW customers only — this whole branch is the create path,
      // so an address someone corrected in Acumatica on an existing customer is never
      // reached, let alone overwritten.
      const { address, stateFellBack, rawState } = buildCustomerAddress(cust);
      if (stateFellBack) {
        console.warn(
          `acumatica-push: state ${JSON.stringify(rawState)} is not a US state code — ` +
            `filed as ${DEFAULT_STATE} for ${recordId}.`
        );
        summary.warnings.push({
          code: "state_fallback",
          value: rawState || null,
          usedState: DEFAULT_STATE,
        });
      }

      // PARENT ACCOUNT (item B). Billing tab; the financing partner decides it.
      const financingPartner = cleanStr(cust.Financing_Partner__c);
      const { parentAccount, unlisted } = resolveParentAccount(financingPartner);
      if (unlisted) {
        console.warn(
          `acumatica-push: financing partner ${JSON.stringify(financingPartner)} is not in ` +
            `FINANCING_PARTNER_PARENT_ACCOUNTS — no parent account set for ${recordId}.`
        );
        summary.warnings.push({ code: "financing_partner_unmapped", value: financingPartner });
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
      // The address hangs off MainContact, not off Customer — there is no MainAddress
      // field on this entity (schema read 2026-09-08). Address is always present, so
      // MainContact is now always sent.
      mainContact.Address = address;
      customerBody.MainContact = mainContact;
      if (zone) customerBody.TaxZone = av(zone);
      // Omitted entirely when there is no parent, rather than sent as "": a blank
      // ParentRecord is a value, and Acumatica would take it as "detach the parent".
      if (parentAccount) customerBody.ParentRecord = av(parentAccount);

      summary.customer.parentAccount = parentAccount;
      summary.customer.financingPartner = financingPartner || null;
      summary.customer.state = address.State.value;

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
      `SELECT Id, Project_Created_in_Acumatica__c, Project_Manager__c, Client__c FROM ${SOLAR_SF_OBJECT} ` +
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
    // RS vs RSDC is decided here, from the customer record already in hand. Both the
    // decision and its input are reported so a wrong template is diagnosable from the
    // button response alone, without re-reading Salesforce.
    const domesticContentEligible = isDomesticContentEligible(cust);
    const projectType = domesticContentEligible
      ? "residential_solar_dc"
      : "residential_solar";
    const templateId = resolveProjectTemplate(projectType);
    summary.project.templateId = templateId;
    summary.project.domesticContentEligible = domesticContentEligible;

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

      // PROJECT MANAGER (item C). Omit-and-warn on anything not confidently resolved —
      // the same rule as the phone and the tax zone, and for the same reason: a project
      // is not worth failing over an unmapped name, and a guessed name is worse than
      // a blank one.
      const pm = resolveProjectManager(solar.Project_Manager__c);
      if (pm.ambiguous) {
        console.warn(
          `acumatica-push: Project_Manager__c ${JSON.stringify(cleanStr(solar.Project_Manager__c))} ` +
            `resolves to more than one Acumatica employee — ProjectManager omitted for ${recordId}.`
        );
        summary.warnings.push({
          code: "project_manager_ambiguous",
          value: cleanStr(solar.Project_Manager__c),
          names: pm.names,
        });
      } else if (!pm.employeeId && pm.unknownNames.length > 0) {
        console.warn(
          `acumatica-push: no Acumatica employee mapped for project manager ` +
            `${JSON.stringify(pm.unknownNames.join("; "))} — ProjectManager omitted for ${recordId}.`
        );
        summary.warnings.push({
          code: "project_manager_unmapped",
          names: pm.unknownNames,
        });
      }
      summary.project.projectManager = pm.employeeId;

      const projectBody = {
        ProjectID: av(projectId),
        ProjectTemplateID: av(templateId), // template auto-scaffolds tasks + budget
        Customer: av(acuCustomerId),
        // JOBTYPE on EVERY project, RS and RSDC alike. The value is the combo's
        // ValueID (`RS`), never the label — see JOBTYPE_VALUE.
        Attributes: [
          {
            AttributeID: av(JOBTYPE_ATTRIBUTE_ID),
            Value: av(JOBTYPE_VALUE),
          },
        ],
      };
      if (description) projectBody.Description = av(description);
      if (pm.employeeId) {
        projectBody.ProjectProperties = { ProjectManager: av(pm.employeeId) };
      }
      summary.project.jobType = JOBTYPE_VALUE;

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

      // VERIFY THE ATTRIBUTE + MANAGER LANDED, by re-reading the project.
      //
      // ⚠️ A 200 is not evidence that an attribute was written. An AttributeID (or a
      // combo value) Acumatica does not recognise is accepted and silently discarded —
      // proved 2026-08-24 with `NOTAREALATTR`, and the whole reason verifyAttributeWrite
      // exists. JOBTYPE is exactly the shape of write that fails this way, because its
      // stored value is a code (`RS`) and every human source for it says the label.
      //
      // A failed verification does NOT fail the push. The project exists and is correctly
      // scaffolded; a missing JOBTYPE is a reporting gap Harmon can fix in one field. It
      // is reported loudly instead, in the summary and in CloudWatch.
      await verifyProjectExtras(returnedProjectId, {
        attributes: projectBody.Attributes,
        expectedManager: pm.employeeId,
        summary,
        recordId,
      });

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

      // ⚠️ THE ONE LINE THAT MAKES A "WRONG TEMPLATE" REPORT ANSWERABLE LATER.
      //
      // Until now this Lambda logged only failures. `templateId` and
      // `domesticContentEligible` went into the HTTP response and nowhere else, so when
      // Harmon reported RSDC projects on non-domestic-content jobs (2026-09) there was
      // no record of what any creation had decided or what it decided it from — the
      // question had to be reconstructed by joining live Acumatica to live Salesforce,
      // both of which had moved on since. The answer turned out to be "the code was
      // right", which is exactly the answer that is expensive to prove without a log.
      //
      // Log the decision AND its input, at INFO, on every create. `dc=` is the field
      // value as it was READ, not the boolean, so an edit made afterwards is visible as
      // a disagreement between this line and the record rather than as a mystery.
      console.log(
        `acumatica-push CREATED project=${returnedProjectId} template=${templateId} ` +
          `dc=${JSON.stringify(cleanStr(cust.Domestic_Content_Eligible__c) || null)} ` +
          `dcEligible=${domesticContentEligible} jobType=${JOBTYPE_VALUE} ` +
          `attributesVerified=${summary.project.attributesVerified} ` +
          `projectManager=${JSON.stringify(pm.employeeId)} ` +
          `customer=${acuCustomerId} customerStage=${summary.customer.stage} ` +
          // Both null when the customer already existed — this run did not set them.
          // customerStage above is what says which of those two things happened.
          `parentAccount=${JSON.stringify(summary.customer.parentAccount)} ` +
          `financingPartner=${JSON.stringify(summary.customer.financingPartner)} ` +
          `sfRecord=${recordId}`
      );
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
