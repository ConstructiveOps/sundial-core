// sundial-service-estimate — the write side of the Service module's estimate / job /
// price-book model (D-072, docs/service-data-model.md). Reads stay on sundial-sf-query
// (cache-first lists) — this Lambda owns every write that has a RULE attached:
//
//   POST   /service/estimates                       new estimate (customer select-or-create)
//   GET    /service/estimates/{id}                  estimate + lines + live totals
//   PATCH  /service/estimates/{id}                  discount / markup / deposit / text / dates
//   POST   /service/estimates/{id}/lines            add line (price-book snapshot or ad hoc)
//   PATCH  /service/estimates/{id}/lines/{lineId}
//   DELETE /service/estimates/{id}/lines/{lineId}
//   POST   /service/estimates/{id}/add-template     clone a template's lines onto it
//   POST   /service/estimates/{id}/recalculate      recompute totals from lines
//   POST   /service/estimates/{id}/send             version++, Version_Log__c, hosted token
//   POST   /service/estimates/{id}/approve          { method, name }  (office-logged or online)
//   POST   /service/estimates/{id}/decline          { reason }
//   POST   /service/estimates/{id}/create-job       the Create Job button
//   POST   /service/jobs                            quick-create: estimate + job in one go
//   POST   /service/price-book-items                create version 1
//   PATCH  /service/price-book-items/{id}           in-place edit (only while unreferenced)
//   POST   /service/price-book-items/{id}/new-version   the "Update" clone
//   POST   /service/price-book-items/{id}/deactivate
//   GET    /service/estimates/{id}/preview          read-only rendered document (what the customer sees)
//   GET    /service/jobs/{id}/activity              the job's activity feed (newest first)
//   GET    /service/jobs/{id}/street-view           the house: Google Street View still, fetched once, cached in S3
//   POST   /service/jobs/{id}/invoice               issue the job's invoice (estimate lines frozen)   ┐
//   GET    /service/jobs/{id}/invoice               the job's current invoice + payments             │
//   GET    /service/invoices/{id}                   one invoice + payments                           │ invoice.js
//   GET    /service/invoices/{id}/preview           the invoice document (HTML)                      │
//   POST   /service/invoices/{id}/payments          record a check / ACH / remittance / refund       │
//   POST   /service/invoices/{id}/send              email the PDF to the payer                       │
//   POST   /service/invoices/{id}/void              void with a reason (reissue = "-2")              ┘
//   GET    /service/estimates/{id}/activity         an estimate's feed (pre-job history)
//
// RULES ENFORCED HERE (the metadata cannot): every job has exactly one estimate and an
// estimate has at most one job; lines belong to the estimate; a customer is required on
// every non-template estimate; one active price-book version per Item_Code__c; no
// in-place edit of a referenced version; totals are recomputed on every line/estimate
// write (totals.js); Requested_Project_Types__c is tagged "Service" on the customer.
// Every successful write also lands one row in the ACTIVITY TRACKER
// (lib/service-activity.js → sundial_service_activity: event, actor, timestamp, details)
// — best-effort, after the Salesforce write, never a reason to fail the request.
//
// LINES ARE EDITABLE AFTER THEY ARE ADDED (Tim, 2026-09-11). The line is a snapshot of
// the price-book item, and the snapshot is the office's copy: description, quantity,
// unit price, taxable, kind can all change per estimate without touching the catalog.
// Price_Overridden__c records a price that diverges from the item; the activity row
// records old → new. A money-affecting edit to an APPROVED line (price / quantity /
// kind / taxable) drops that line back to Proposed so the customer approves the change
// on the next send; description-only edits do not.
//
// TENANT ISOLATION: tenantId comes ONLY from resolveIdentity. Every record read is
// `WHERE Id = … AND Client__c = tenant` (cross-tenant == not found == 404); every create
// stamps Client__c from the token. Access: tenant scope only (alwaysEnforcedAccess —
// the module is new, so there is no previous behaviour a switch would preserve).
//
// SEND DELIVERS (2026-09-11): /send records the version, mints the hosted token, builds
// the customer link (SERVICE_PUBLIC_BASE_URL + /estimate/{token}) and emails it through
// lib/email.js (SES; EMAIL_FROM / EMAIL_REPLY_TO / EMAIL_CONFIG_SET). Every way the
// email can NOT go out (no base URL, SES not configured, no customer email, SES error)
// comes back as delivery "recorded" + deliveryDetail so the office knows to send the
// link by hand — the version is on the record either way. SMS waits for Twilio.
// The customer side of that link is lambdas/sundial-service-public (view / accept /
// decline by token, no login).
//
// NOT HERE (deliberately, next increments): the PDF per send, SMS, the AZ city tax
// table (Tax_Rate__c is set per estimate for now), invoices/payments.
//
// Dependencies are injectable (createHandler) so test.js drives the real router with
// recorded Salesforce calls and no module mocking.

import { randomBytes } from "node:crypto";
import { resolveIdentity as realResolveIdentity } from "../../lib/identity.js";
import {
  sfQuery as realSfQuery,
  sfCreateRecord as realSfCreateRecord,
  sfUpdateRecord as realSfUpdateRecord,
  sfDeleteRecord as realSfDeleteRecord,
  describeObject as realDescribeObject,
  soqlEscapeString,
} from "../../lib/salesforce.js";
import { getSupabaseClient as realGetSupabaseClient } from "../../lib/supabase.js";
import { getSecret as realGetSecret } from "../../lib/secrets.js";
import { sendEmail as realSendEmail, isEmailConfigured as realIsEmailConfigured } from "../../lib/email.js";
import { alwaysEnforcedAccess, assertAction } from "../../lib/access-enforce.js";
import { renderEstimateDocument, buildEstimateModel, DEFAULT_BRAND } from "../../lib/estimate-document.js";
import { renderEstimatePdf as realRenderEstimatePdf } from "../../lib/estimate-pdf.js";
import {
  buildKey,
  publicUrlForKey,
  registerFileMetadata,
  findFileMetadataByKey,
  S3_BUCKET,
  S3_REGION,
} from "../../lib/file-access.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  EVENTS,
  recordActivity,
  linkEstimateActivityToJob,
  listActivity,
  diffFields,
} from "../../lib/service-activity.js";
import {
  corsHeaders,
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  parseJsonBody,
  httpMethod,
} from "../../lib/http.js";
import { computeTotals, lineFromRecord, estimateFromRecord } from "./totals.js";
import {
  CUSTOMER_SF_OBJECT,
  PROJECT_TYPES_FIELD,
  candidateSoql,
  matchCandidates,
  normalizeNewCustomer,
  buildNewCustomerFields,
  unionProjectTypes,
  matchPicklist,
  CANDIDATE_SELECT,
} from "./customer.js";
import {
  ITEM_SF_OBJECT,
  LINE_SF_OBJECT,
  ITEM_SELECT,
  LINE_SELECT,
  itemFieldsFromBody,
  newVersionFields,
  supersededFields,
  inPlaceEditable,
  lineFromItem,
  adHocLine,
  linePatchFields,
  linkLineToItem,
  cloneLineFields,
} from "./pricebook.js";

import { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT, ESTIMATE_SELECT } from "./fields.js";
import { createInvoiceHandlers } from "./invoice.js";
export { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT, ESTIMATE_SELECT };

// The module's product-history tag on the customer (D-072 amendment). "Service" is a
// Sundial product category, not a Harmon value — Roofing / Commercial pass their own.
export const PROJECT_TYPE_TAG = "Service";

// Tenant config placeholders — read from Sundial_Tenant__c config when that surface
// lands (service-workflows.md §12). GET FROM HARMON: validity days, default template.
export const DEFAULTS = Object.freeze({
  validDays: 30,
  publicTokenDays: 45,
});

// Where the customer-facing estimate page lives (the portal's public /estimate/{token}
// route, harmon-crm). Per-deployment config, not a credential — env var like
// EMAIL_FROM. Unset ⇒ Send records the version and returns the token but sends no
// email (the response says so), rather than emailing a link that goes nowhere.
export const PUBLIC_BASE_URL = (process.env.SERVICE_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
export function publicEstimateUrl(token, baseUrl = PUBLIC_BASE_URL) {
  return baseUrl && token ? `${baseUrl}/estimate/${encodeURIComponent(token)}` : null;
}

// Company name on the document + the email. Same env var the public Lambda reads, so
// the office preview, the customer page, the PDF and the email all say the same name.
// Falls back to the tenant slug (capitalised) until it is set.
export const BRAND_NAME = process.env.SERVICE_BRAND_NAME || "";

// The PDF of each sent version lives with the estimate's files (D-072.5):
//   SUNDIAL/{estimateId}/estimate-v{n}.pdf
// Deterministic key: a retry of the same version overwrites in place, never piles up.
export function estimatePdfKey(estimateId, version) {
  return buildKey(estimateId, `estimate-v${version}.pdf`);
}

let _s3 = null;
function s3() {
  if (!_s3) _s3 = new S3Client({ region: S3_REGION });
  return _s3;
}

/** The customer email for an estimate send: what the customer record says today. */
const CUSTOMER_EMAIL_SELECT = "Id, Primary_Email__c, Name";

/** Plain, deliverable email — the link is the point; the document lives on the page. */
export function buildEstimateEmail({ est, total, url, brandName, validUntil }) {
  const number = est.Name || "Estimate";
  const who = brandName ? ` from ${brandName}` : "";
  const money = Number.isFinite(Number(total)) ? Number(total).toLocaleString("en-US", { style: "currency", currency: "USD" }) : "";
  const subject = `Your estimate ${number}${who}${money ? ` — ${money}` : ""}`;
  const validLine = validUntil ? `This estimate is valid through ${validUntil}.` : "";
  const text = [
    `Hello${est.Customer_Name_at_Creation__c ? ` ${est.Customer_Name_at_Creation__c}` : ""},`,
    "",
    `Your estimate ${number}${who} is ready${money ? ` (${money})` : ""}.`,
    `View and approve it here: ${url}`,
    "",
    validLine,
    "Approving lets us get the work scheduled. Questions? Just reply to this email.",
  ].filter((l) => l !== null).join("\n");
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;max-width:560px">
  <p>Hello${est.Customer_Name_at_Creation__c ? ` ${esc(est.Customer_Name_at_Creation__c)}` : ""},</p>
  <p>Your estimate <strong>${esc(number)}</strong>${esc(who)} is ready${money ? ` (<strong>${esc(money)}</strong>)` : ""}.</p>
  <p style="margin:24px 0"><a href="${esc(url)}" style="background:#1F3864;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">View and approve your estimate</a></p>
  ${validLine ? `<p style="color:#52525b">${esc(validLine)}</p>` : ""}
  <p style="color:#52525b">Approving lets us get the work scheduled. Questions? Just reply to this email.</p>
  <p style="color:#a1a1aa;font-size:12px">If the button doesn't work, copy this link: ${esc(url)}</p>
</div>`;
  return { subject, text, html };
}

const CACHE = Object.freeze({
  estimate: "sundial_estimate_cache",
  job: "sundial_service_job_cache",
  line: "sundial_service_line_cache",
  item: "sundial_price_book_item_cache",
  customer: "sundial_customer_cache",
  invoice: "sundial_service_invoice_cache",
  payment: "sundial_service_payment_cache",
});


// Estimate fields the office may PATCH directly (money inputs, not money outputs).
const ESTIMATE_PATCHABLE = Object.freeze({
  discountScope: ["Discount_Scope__c", (v) => v],
  discountType: ["Discount_Type__c", (v) => v],
  discountValue: ["Discount_Value__c", numOrNull],
  discountSource: ["Discount_Source__c", (v) => v],
  markupType: ["Markup_Type__c", (v) => v],
  markupValue: ["Markup_Value__c", numOrNull],
  taxRate: ["Tax_Rate__c", numOrNull],
  taxJurisdiction: ["Tax_Jurisdiction__c", strOrNull],
  depositRequired: ["Deposit_Required__c", (v) => v === true],
  depositType: ["Deposit_Type__c", (v) => v],
  depositValue: ["Deposit_Value__c", numOrNull],
  scopeSummary: ["Scope_Summary__c", strOrNull],
  validUntil: ["Valid_Until__c", strOrNull],
  soldById: ["Sold_By__c", strOrNull],
  templateName: ["Template_Name__c", strOrNull],
  originatingSolarId: ["Originating_Solar_Project__c", strOrNull],
  originatingRoofingId: ["Originating_Roofing_Project__c", strOrNull],
  originatingCommercialId: ["Originating_Commercial_Project__c", strOrNull],
});

const JOB_CREATE_FIELDS = Object.freeze({
  issueDescription: ["Issue_Description__c", strOrNull],
  priority: ["Priority__c", (v) => v],
  serviceType: ["Service_Type__c", (v) => v],
  systemOwnership: ["System_Ownership__c", (v) => v],
  intakeChannel: ["Intake_Channel__c", (v) => v],
  intakeDate: ["Intake_Date__c", strOrNull],
  assignedToId: ["Assigned_To__c", strOrNull],
  billToType: ["Bill_To_Type__c", (v) => v],
  billToName: ["Bill_To_Name__c", strOrNull],
  billingReference: ["Billing_Reference__c", strOrNull],
  originatingSolarId: ["Originating_Solar_Project__c", strOrNull],
  originatingRoofingId: ["Originating_Roofing_Project__c", strOrNull],
  originatingCommercialId: ["Originating_Commercial_Project__c", strOrNull],
});

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function translate(body, map) {
  const fields = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!map[k]) {
      rejected.push(k);
      continue;
    }
    if (v === undefined) continue;
    const [api, fn] = map[k];
    fields[api] = fn(v);
  }
  return { fields, rejected };
}
function bad(cors, code, message, extra = {}) {
  return jsonResponse(400, cors, { error: "bad_request", code, message, ...extra });
}
function notFound(cors) {
  return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
}
function sfError(cors, err, where) {
  console.error(`service-estimate ${where}:`, err?.sfStatus, err?.sfBody || err?.message || err);
  return jsonResponse(502, cors, {
    error: "salesforce_error",
    code: "SALESFORCE_ERROR",
    where,
    message: err?.sfBody ? String(err.sfBody).slice(0, 500) : err?.message || "Salesforce write failed",
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const ROUTES = [
  ["POST", /^\/service\/estimates\/?$/, "createEstimate"],
  ["GET", /^\/service\/estimates\/([^/]+)\/?$/, "getEstimate"],
  ["PATCH", /^\/service\/estimates\/([^/]+)\/?$/, "patchEstimate"],
  ["POST", /^\/service\/estimates\/([^/]+)\/lines\/?$/, "addLine"],
  ["PATCH", /^\/service\/estimates\/([^/]+)\/lines\/([^/]+)\/?$/, "patchLine"],
  ["DELETE", /^\/service\/estimates\/([^/]+)\/lines\/([^/]+)\/?$/, "deleteLine"],
  ["POST", /^\/service\/estimates\/([^/]+)\/add-template\/?$/, "addTemplate"],
  ["POST", /^\/service\/estimates\/([^/]+)\/recalculate\/?$/, "recalculate"],
  ["POST", /^\/service\/estimates\/([^/]+)\/send\/?$/, "sendEstimate"],
  ["POST", /^\/service\/estimates\/([^/]+)\/approve\/?$/, "approveEstimate"],
  ["POST", /^\/service\/estimates\/([^/]+)\/decline\/?$/, "declineEstimate"],
  ["POST", /^\/service\/estimates\/([^/]+)\/create-job\/?$/, "createJobFromEstimate"],
  ["POST", /^\/service\/jobs\/?$/, "createJob"],
  ["POST", /^\/service\/price-book-items\/?$/, "createItem"],
  ["PATCH", /^\/service\/price-book-items\/([^/]+)\/?$/, "patchItem"],
  ["POST", /^\/service\/price-book-items\/([^/]+)\/new-version\/?$/, "newItemVersion"],
  ["POST", /^\/service\/price-book-items\/([^/]+)\/deactivate\/?$/, "deactivateItem"],
  ["GET", /^\/service\/estimates\/([^/]+)\/preview\/?$/, "previewEstimate"],
  ["GET", /^\/service\/jobs\/([^/]+)\/activity\/?$/, "jobActivity"],
  ["GET", /^\/service\/jobs\/([^/]+)\/street-view\/?$/, "jobStreetView"],
  ["POST", /^\/service\/jobs\/([^/]+)\/invoice\/?$/, "issueInvoice"],
  ["GET", /^\/service\/jobs\/([^/]+)\/invoice\/?$/, "getJobInvoice"],
  ["GET", /^\/service\/invoices\/([^/]+)\/preview\/?$/, "previewInvoice"],
  ["GET", /^\/service\/invoices\/([^/]+)\/?$/, "getInvoice"],
  ["POST", /^\/service\/invoices\/([^/]+)\/payments\/?$/, "recordPayment"],
  ["POST", /^\/service\/invoices\/([^/]+)\/send\/?$/, "sendInvoice"],
  ["POST", /^\/service\/invoices\/([^/]+)\/void\/?$/, "voidInvoice"],
  ["GET", /^\/service\/estimates\/([^/]+)\/activity\/?$/, "estimateActivity"],
];

export function matchRoute(method, path) {
  // Strip a stage prefix ("/prod/service/...") if the gateway passes one.
  const p = (path || "").replace(/^\/[^/]+(?=\/service\/)/, "");
  for (const [m, re, name] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (hit) return { name, params: hit.slice(1).map((s) => decodeURIComponent(s)) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------
// --- Street View (data-model §5.2, the 9/9 ask) ----------------------------------
// The Google key lives in Secrets Manager (`sundial/google-maps` → { apiKey }), never in
// the browser or an env var. The still is fetched ONCE per job and cached in S3 next to
// the job's files; the job remembers the key. "NONE" in the field means Google was
// asked and has no imagery for the address, so the page stops asking.
export const STREET_VIEW_SECRET = "sundial/google-maps";
export const STREET_VIEW_NONE = "NONE";
export const STREET_VIEW_SIZE = "640x400";
export const streetViewKey = (jobId) => buildKey(jobId, "street-view.jpg");

export function createHandler(deps = {}) {
  const d = {
    resolveIdentity: realResolveIdentity,
    sfQuery: realSfQuery,
    sfCreateRecord: realSfCreateRecord,
    sfUpdateRecord: realSfUpdateRecord,
    sfDeleteRecord: realSfDeleteRecord,
    describeObject: realDescribeObject,
    getSupabaseClient: realGetSupabaseClient,
    sendEmail: realSendEmail,
    isEmailConfigured: realIsEmailConfigured,
    publicBaseUrl: PUBLIC_BASE_URL,
    brandName: BRAND_NAME,
    renderPdf: realRenderEstimatePdf,
    putObject: async ({ key, body, contentType }) =>
      s3().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType })),
    now: () => new Date(),
    randomToken: () => randomBytes(24).toString("base64url"),
    getSecret: realGetSecret,
    fetchUrl: (url) => fetch(url),
    ...deps,
  };

  // Brand block for the document. Per-tenant config when that surface lands
  // (service-workflows.md §12); until then SERVICE_BRAND_NAME, else the tenant slug, so
  // the layout can be reviewed. The identity block is a GET-FROM-HARMON item.
  const brandFor = (ctx) => ({
    ...DEFAULT_BRAND,
    companyName: d.brandName || (ctx.tenantSlug ? ctx.tenantSlug.replace(/\b\w/g, (c) => c.toUpperCase()) : ""),
  });

  // --- describe cache (picklist guards) ------------------------------------------
  const describeCache = new Map();
  const DESCRIBE_TTL_MS = 5 * 60 * 1000;
  async function picklistValues(sfObject, field) {
    const key = sfObject;
    let hit = describeCache.get(key);
    if (!hit || Date.now() - hit.at > DESCRIBE_TTL_MS) {
      try {
        const meta = await d.describeObject(sfObject);
        hit = { at: Date.now(), meta };
        describeCache.set(key, hit);
      } catch (e) {
        console.error("describe failed:", sfObject, e?.message || e);
        return null; // unknown → caller skips the guarded write with a warning
      }
    }
    const f = hit.meta?.fields?.find((x) => x.name === field);
    return f?.picklistValues ?? null;
  }

  // --- cache stale flags (best-effort, never fail the write) ----------------------
  async function markStale(table, ids, tenantId) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return;
    try {
      const supabase = await d.getSupabaseClient();
      const { error } = await supabase
        .from(table)
        .update({ is_stale: true })
        .in("sf_id", list)
        .eq("client_sf_id", tenantId);
      if (error) console.error(`cache stale-flag error (${table}):`, error.message);
    } catch (e) {
      console.error(`cache stale-flag threw (${table}):`, e?.message || String(e));
    }
  }

  // --- activity tracker (best-effort; see lib/service-activity.js) ------------------
  async function act(ctx, entry) {
    return recordActivity(d.getSupabaseClient, {
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      actor: ctx.actor,
      at: d.now().toISOString(),
      ...entry,
    });
  }

  // --- tenant-scoped reads --------------------------------------------------------
  async function loadEstimate(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${ESTIMATE_SELECT} FROM ${ESTIMATE_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadLines(estimateId, tenantId) {
    return (
      (await d.sfQuery(
        `SELECT ${LINE_SELECT} FROM ${LINE_SF_OBJECT} WHERE Estimate__c = '${soqlEscapeString(estimateId)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY Sort_Order__c NULLS LAST, CreatedDate`
      )) || []
    );
  }
  async function loadItem(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${ITEM_SELECT} FROM ${ITEM_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadJob(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT Id, Name, Estimate__c, Sundial_Customer__c FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadCustomer(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${CANDIDATE_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function countLinesReferencing(itemId, tenantId) {
    // sfQuery returns records (no totalSize), so count ids — capped; the answer that
    // matters is zero vs non-zero, the number is for the message.
    const rows = await d.sfQuery(
      `SELECT Id FROM ${LINE_SF_OBJECT} WHERE Price_Book_Item__c = '${soqlEscapeString(itemId)}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 200`,
      { maxRecords: 200 }
    );
    return Array.isArray(rows) ? rows.length : 0;
  }

  // --- totals: recompute + persist ----------------------------------------------
  async function recomputeAndStore(est, tenantId) {
    const lines = await loadLines(est.Id, tenantId);
    const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
    await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, totals.fields);
    await markStale(CACHE.estimate, [est.Id], tenantId);
    return { totals, lines };
  }

  // --- customer select-or-create (§3.1a) ------------------------------------------
  // Returns { ok:true, customer, created, warnings, events } or { ok:false, response }.
  // `events` are activity rows deferred until the estimate/job exists, so the customer
  // step shows up on the job's feed (with the estimate/job ids) rather than floating.
  async function resolveCustomer(body, ctx, cors) {
    const { tenantId } = ctx;
    const events = [];
    const spec = body?.customer;
    if (!spec || typeof spec !== "object") {
      return { ok: false, response: bad(cors, "CUSTOMER_REQUIRED", "Provide customer: { id } or customer: { new: {...} }.") };
    }
    const warnings = [];
    const values = await picklistValues(CUSTOMER_SF_OBJECT, PROJECT_TYPES_FIELD);
    const tag = values ? matchPicklist(PROJECT_TYPE_TAG, values) : null;
    if (!tag) {
      warnings.push(
        `${PROJECT_TYPES_FIELD} has no "${PROJECT_TYPE_TAG}" value in this org — customer not tagged. Add the picklist value in Setup.`
      );
    }

    if (spec.id) {
      const customer = await loadCustomer(String(spec.id), tenantId);
      if (!customer) return { ok: false, response: notFound(cors) };
      if (tag) {
        const merged = unionProjectTypes(customer[PROJECT_TYPES_FIELD], tag);
        if (merged) {
          try {
            await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, { [PROJECT_TYPES_FIELD]: merged });
            customer[PROJECT_TYPES_FIELD] = merged;
            await markStale(CACHE.customer, [customer.Id], tenantId);
            events.push({ event: EVENTS.CUSTOMER_TAGGED, recordType: "customer", recordSfId: customer.Id, details: { field: PROJECT_TYPES_FIELD, to: merged } });
          } catch (e) {
            // Tagging is bookkeeping; the estimate/job still gets created.
            warnings.push(`Could not tag the customer with ${PROJECT_TYPE_TAG}: ${e?.sfBody || e?.message || e}`);
          }
        }
      }
      return { ok: true, customer, created: false, warnings, events };
    }

    if (spec.new) {
      const norm = normalizeNewCustomer(spec.new);
      if (!norm.ok) {
        return { ok: false, response: bad(cors, "CUSTOMER_INVALID", "New customer needs a name and an email or phone.", { missing: norm.missing }) };
      }
      const c = norm.value;
      // Soft duplicate guard — unless the office already looked and said "create anyway".
      if (spec.confirmNew !== true) {
        const soql = candidateSoql(tenantId, c);
        const rows = soql ? await d.sfQuery(soql) : [];
        const candidates = matchCandidates(rows, c);
        if (candidates.length) {
          return {
            ok: false,
            response: jsonResponse(409, cors, {
              error: "duplicate_candidates",
              code: "DUPLICATE_CANDIDATES",
              message: "Possible existing customer(s). Pick one, or resend with customer.confirmNew: true.",
              candidates,
            }),
          };
        }
      }
      const stateValues = await picklistValues(CUSTOMER_SF_OBJECT, "State__c");
      const fields = buildNewCustomerFields(c, {
        pickState: (v) => {
          if (!stateValues) return v;
          const m = matchPicklist(v, stateValues);
          if (!m) warnings.push(`State "${v}" is not a State__c picklist value — left blank.`);
          return m;
        },
      });
      fields.Client__c = tenantId;
      if (tag) fields[PROJECT_TYPES_FIELD] = tag;
      let created;
      try {
        created = await d.sfCreateRecord(CUSTOMER_SF_OBJECT, fields);
      } catch (e) {
        return { ok: false, response: sfError(cors, e, "customer create") };
      }
      const customer = { Id: created.id, ...fields };
      events.push({ event: EVENTS.CUSTOMER_CREATED, recordType: "customer", recordSfId: customer.Id, details: { name: fields.Name, tagged: tag ? [tag] : [], viaPopup: true } });
      return { ok: true, customer, created: true, warnings, events };
    }
    return { ok: false, response: bad(cors, "CUSTOMER_REQUIRED", "customer must carry id or new.") };
  }

  async function flushEvents(ctx, events, refs) {
    for (const e of events || []) await act(ctx, { ...e, ...refs });
  }

  function snapshotFields(customer) {
    return {
      Customer_Name_at_Creation__c: customer.Name ?? [customer.First_Name__c, customer.Last_Name__c].filter(Boolean).join(" ") ?? null,
      Address_at_Creation__c: [customer.Street__c, customer.City__c, customer.State__c, customer.Postal_Code__c].filter(Boolean).join(", ") || null,
      Primary_Phone_at_Creation__c: customer.Primary_Phone__c ?? null,
      Primary_Email_at_Creation__c: customer.Primary_Email__c ?? null,
    };
  }

  // --- estimate creation core (shared by createEstimate / createJob) ---------------
  async function createEstimateRecord({ customer, body, tenantId, userId }) {
    const { fields: extra, rejected } = translate(body?.estimate || {}, ESTIMATE_PATCHABLE);
    const isTemplate = body?.isTemplate === true;
    const fields = {
      Client__c: tenantId,
      Status__c: isTemplate ? "Template" : "Draft",
      Version__c: 0,
      Is_Template__c: isTemplate,
      Discount_Scope__c: "Both",
      Discount_Type__c: "Percent",
      Markup_Type__c: "Percent",
      Deposit_Type__c: "Percent",
      ...extra,
    };
    if (!isTemplate) {
      fields.Sundial_Customer__c = customer.Id;
      Object.assign(fields, snapshotFields(customer));
    }
    if (fields.Sold_By__c === undefined && body?.soldBySelf === true && userId) fields.Sold_By__c = userId;
    for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
    const created = await d.sfCreateRecord(ESTIMATE_SF_OBJECT, fields);
    return { id: created.id, fields, rejected };
  }

  async function addLinesToEstimate(estimateId, tenantId, lines) {
    const createdIds = [];
    const problems = [];
    let sort = 0;
    for (const spec of lines || []) {
      sort += 10;
      let fields;
      if (spec?.priceBookItemId) {
        const item = await loadItem(String(spec.priceBookItemId), tenantId);
        if (!item) {
          problems.push(`price book item ${spec.priceBookItemId} not found`);
          continue;
        }
        if (item.Is_Active__c !== true) {
          problems.push(`price book item ${item.Item_Code__c} v${item.Version__c} is not the active version`);
          continue;
        }
        fields = lineFromItem(item, { ...spec, sortOrder: spec.sortOrder ?? sort }, { estimateId, tenantId });
      } else {
        const r = adHocLine({ ...spec, sortOrder: spec?.sortOrder ?? sort }, { estimateId, tenantId });
        if (r.problems) {
          problems.push(...r.problems);
          continue;
        }
        fields = r.fields;
      }
      const c = await d.sfCreateRecord(LINE_SF_OBJECT, fields);
      createdIds.push(c.id);
    }
    return { createdIds, problems };
  }

  async function cloneTemplateLines(templateId, estimateId, tenantId) {
    const tpl = await loadEstimate(templateId, tenantId);
    if (!tpl || tpl.Is_Template__c !== true) return { error: "TEMPLATE_NOT_FOUND" };
    const existing = await loadLines(estimateId, tenantId);
    const offset = existing.reduce((m, l) => Math.max(m, Number(l.Sort_Order__c) || 0), 0);
    const lines = await loadLines(templateId, tenantId);
    const ids = [];
    for (const l of lines) {
      let fields = cloneLineFields(l, { estimateId, tenantId, sortOffset: offset });
      // Re-snapshot from the CURRENT active version of the item so a template never
      // resurrects a superseded price; keep the template's quantity and description.
      if (l.Price_Book_Item__c) {
        let item = await loadItem(l.Price_Book_Item__c, tenantId);
        if (item && item.Is_Active__c !== true && item.Item_Code__c) {
          // The template still points at a superseded version: follow the code to
          // whatever is active today.
          const active = await d.sfQuery(
            `SELECT ${ITEM_SELECT} FROM ${ITEM_SF_OBJECT} WHERE Item_Code__c = '${soqlEscapeString(item.Item_Code__c)}' ` +
              `AND Client__c = '${soqlEscapeString(tenantId)}' AND Is_Active__c = true LIMIT 1`
          );
          item = active?.[0] ?? item;
        }
        if (item && item.Is_Active__c === true) {
          fields = lineFromItem(item, {
            quantity: l.Quantity__c,
            description: l.Description__c,
            sortOrder: fields.Sort_Order__c,
            source: "Template",
            showUnitPrice: l.Show_Unit_Price__c !== false,
          }, { estimateId, tenantId });
        }
      }
      const c = await d.sfCreateRecord(LINE_SF_OBJECT, fields);
      ids.push(c.id);
    }
    return { ids, count: ids.length };
  }

  async function createJobRecord({ customer, estimateId, body, tenantId }) {
    const { fields: extra, rejected } = translate(body?.job || {}, JOB_CREATE_FIELDS);
    const fields = {
      Client__c: tenantId,
      Sundial_Customer__c: customer.Id,
      Estimate__c: estimateId,
      Status__c: "New",
      Priority__c: "Standard",
      Bill_To_Type__c: "Customer",
      Intake_Date__c: d.now().toISOString(),
      Payment_Status__c: "None",
      Geocode_Status__c: "Pending",
      ...snapshotFields(customer),
      ...extra,
    };
    for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
    const created = await d.sfCreateRecord(JOB_SF_OBJECT, fields);
    return { id: created.id, fields, rejected };
  }

  // ---------------------------------------------------------------------------
  // Route handlers. Each receives { ctx: { tenantId, userId, cors }, params, body }.
  // ---------------------------------------------------------------------------
  const H = {
    async createEstimate({ ctx, body }) {
      const { tenantId, userId, cors } = ctx;
      let customer = null;
      let customerCreated = false;
      let warnings = [];
      let customerEvents = [];
      if (body?.isTemplate !== true) {
        const r = await resolveCustomer(body, ctx, cors);
        if (!r.ok) return r.response;
        ({ customer, warnings } = r);
        customerCreated = r.created;
        customerEvents = r.events;
      }
      let est;
      try {
        est = await createEstimateRecord({ customer, body, tenantId, userId });
      } catch (e) {
        const resp = sfError(cors, e, "estimate create");
        if (customerCreated) resp.body = JSON.stringify({ ...JSON.parse(resp.body), customerCreated: true, customerId: customer.Id });
        return resp;
      }
      const lineResult = await addLinesToEstimate(est.id, tenantId, body?.lines);
      let template = null;
      if (body?.templateId) {
        template = await cloneTemplateLines(String(body.templateId), est.id, tenantId);
        if (template.error) warnings.push(`template ${body.templateId} not found — no lines added from it`);
      }
      const full = await loadEstimate(est.id, tenantId);
      const { totals } = await recomputeAndStore(full, tenantId);
      await flushEvents(ctx, customerEvents, { estimateSfId: est.id });
      await act(ctx, {
        event: EVENTS.ESTIMATE_CREATED, recordType: "estimate", recordSfId: est.id, estimateSfId: est.id,
        details: { number: full?.Name ?? null, isTemplate: body?.isTemplate === true, customerId: customer?.Id ?? null, customerCreated, linesCreated: lineResult.createdIds.length + (template?.count ?? 0), templateId: body?.templateId ?? null, total: totals.total },
      });
      return jsonResponse(201, cors, {
        success: true,
        id: est.id,
        customerId: customer?.Id ?? null,
        customerCreated,
        linesCreated: lineResult.createdIds.length + (template?.count ?? 0),
        lineProblems: lineResult.problems,
        totals: totals.fields,
        rejectedFields: est.rejected,
        warnings,
      });
    },

    async getEstimate({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      const lines = await loadLines(est.Id, tenantId);
      const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
      return jsonResponse(200, cors, { estimate: est, lines, totals });
    },

    async patchEstimate({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      const { fields, rejected } = translate(body, ESTIMATE_PATCHABLE);
      if (!Object.keys(fields).length) return bad(cors, "NO_FIELDS", "Nothing to update.", { rejectedFields: rejected });
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
      } catch (e) {
        return sfError(cors, e, "estimate update");
      }
      const { totals } = await recomputeAndStore({ ...est, ...fields }, tenantId);
      await act(ctx, { event: EVENTS.ESTIMATE_UPDATED, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { fields: diffFields(est, fields), total: totals.total } });
      return jsonResponse(200, cors, { success: true, id: est.Id, totals: totals.fields, rejectedFields: rejected });
    },

    async addLine({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      const specs = Array.isArray(body?.lines) ? body.lines : [body];
      let result;
      try {
        result = await addLinesToEstimate(est.Id, tenantId, specs);
      } catch (e) {
        return sfError(cors, e, "line create");
      }
      if (!result.createdIds.length) return bad(cors, "LINE_INVALID", "No line could be added.", { problems: result.problems });
      const { totals, lines: after } = await recomputeAndStore(est, tenantId);
      await markStale(CACHE.line, result.createdIds, tenantId);
      for (const id of result.createdIds) {
        const l = after.find((x) => x.Id === id) || {};
        await act(ctx, { event: EVENTS.LINE_ADDED, recordType: "serviceline", recordSfId: id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { description: l.Description__c ?? null, kind: l.Kind__c ?? null, quantity: l.Quantity__c ?? null, unitPrice: l.Unit_Price__c ?? null, priceBookItemId: l.Price_Book_Item__c ?? null, source: l.Source__c ?? null, total: totals.total } });
      }
      return jsonResponse(201, cors, { success: true, ids: result.createdIds, problems: result.problems, totals: totals.fields });
    },

    async patchLine({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      const lineId = params[1];
      const lines = await loadLines(est.Id, tenantId);
      const line = lines.find((l) => l.Id === lineId);
      if (!line) return notFound(cors);
      // `priceBookItemId` links the line to a catalog item (the "save to price book"
      // flow creates the item first, then PATCHes the line with its id). It is handled
      // apart from the plain field map because it re-snapshots several fields at once.
      const { priceBookItemId, ...plain } = body && typeof body === "object" ? body : {};
      const { fields, rejected, problems } = linePatchFields(plain);
      if (problems.length) return bad(cors, "LINE_INVALID", problems.join("; "));
      let linkedItem = null;
      if (priceBookItemId != null) {
        linkedItem = await loadItem(String(priceBookItemId), tenantId);
        if (!linkedItem) return bad(cors, "ITEM_NOT_FOUND", `Price book item ${priceBookItemId} was not found.`);
        if (linkedItem.Is_Active__c !== true) {
          return bad(cors, "ITEM_NOT_ACTIVE", `${linkedItem.Item_Code__c} v${linkedItem.Version__c} is not the active version.`);
        }
        // The plain edits win over the snapshot (a caller may link AND set a price).
        Object.assign(fields, { ...linkLineToItem({ ...line, ...fields }, linkedItem), ...fields });
      }
      if (!Object.keys(fields).length) return bad(cors, "NO_FIELDS", "Nothing to update.", { rejectedFields: rejected });
      // An edited price on a catalog line is an override; record it.
      if (fields.Unit_Price__c != null && (linkedItem || line.Price_Book_Item__c)) {
        const item = linkedItem || (await loadItem(line.Price_Book_Item__c, tenantId));
        const itemPrice = Number(item?.Price__c ?? NaN);
        fields.Price_Overridden__c = !Number.isFinite(itemPrice) || Math.abs(itemPrice - fields.Unit_Price__c) > 0.004;
      }
      // A money-affecting edit to an APPROVED line needs the customer's approval again:
      // drop it to Proposed (unless the caller is explicitly setting a stage).
      const MONEY_FIELDS = ["Unit_Price__c", "Quantity__c", "Kind__c", "Taxable__c"];
      const changed = diffFields(line, fields);
      const moneyChanged = MONEY_FIELDS.some((f) => f in changed);
      let reapproval = false;
      if (line.Stage__c === "Approved" && moneyChanged && !("Stage__c" in fields)) {
        fields.Stage__c = "Proposed";
        reapproval = true;
      }
      if (!Object.keys(changed).length && !("Stage__c" in fields)) {
        return jsonResponse(200, cors, { success: true, id: lineId, unchanged: true, rejectedFields: rejected });
      }
      try {
        await d.sfUpdateRecord(LINE_SF_OBJECT, lineId, fields);
      } catch (e) {
        return sfError(cors, e, "line update");
      }
      const { totals } = await recomputeAndStore(est, tenantId);
      await markStale(CACHE.line, [lineId], tenantId);
      await act(ctx, { event: EVENTS.LINE_UPDATED, recordType: "serviceline", recordSfId: lineId, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { description: fields.Description__c ?? line.Description__c ?? null, fields: diffFields(line, fields), needsReapproval: reapproval, linkedItemCode: linkedItem?.Item_Code__c ?? null, total: totals.total } });
      return jsonResponse(200, cors, { success: true, id: lineId, needsReapproval: reapproval, priceBookItemId: linkedItem?.Id ?? line.Price_Book_Item__c ?? null, totals: totals.fields, rejectedFields: rejected });
    },

    async deleteLine({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      const lineId = params[1];
      const lines = await loadLines(est.Id, tenantId);
      const line = lines.find((l) => l.Id === lineId);
      if (!line) return notFound(cors);
      try {
        await d.sfDeleteRecord(LINE_SF_OBJECT, lineId);
      } catch (e) {
        return sfError(cors, e, "line delete");
      }
      const { totals } = await recomputeAndStore(est, tenantId);
      await markStale(CACHE.line, [lineId], tenantId);
      await act(ctx, { event: EVENTS.LINE_REMOVED, recordType: "serviceline", recordSfId: lineId, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { description: line.Description__c ?? null, quantity: line.Quantity__c ?? null, unitPrice: line.Unit_Price__c ?? null, total: totals.total } });
      return jsonResponse(200, cors, { success: true, id: lineId, totals: totals.fields });
    },

    async addTemplate({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (!body?.templateId) return bad(cors, "TEMPLATE_REQUIRED", "templateId is required.");
      let r;
      try {
        r = await cloneTemplateLines(String(body.templateId), est.Id, tenantId);
      } catch (e) {
        return sfError(cors, e, "template clone");
      }
      if (r.error) return notFound(cors);
      const { totals } = await recomputeAndStore(est, tenantId);
      await act(ctx, { event: EVENTS.TEMPLATE_APPLIED, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { templateId: String(body.templateId), linesAdded: r.count, total: totals.total } });
      return jsonResponse(201, cors, { success: true, ids: r.ids, totals: totals.fields });
    },

    async recalculate({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      const { totals } = await recomputeAndStore(est, tenantId);
      return jsonResponse(200, cors, { success: true, id: est.Id, totals: totals.fields });
    },

    async sendEstimate({ ctx, params, body }) {
      const { tenantId, userId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Is_Template__c === true) return bad(cors, "TEMPLATE_NOT_SENDABLE", "Templates are never sent.");
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      const { totals, lines } = await recomputeAndStore(est, tenantId);
      const now = d.now();
      const version = (Number(est.Version__c) || 0) + 1;
      const via = ["Email", "SMS", "Both", "Manual"].includes(body?.via) ? body.via : "Email";
      const validDays = Number(body?.validDays) > 0 ? Number(body.validDays) : DEFAULTS.validDays;
      const validUntil = new Date(now.getTime() + validDays * 86400000);
      const tokenExpires = new Date(now.getTime() + Math.max(validDays, DEFAULTS.publicTokenDays) * 86400000);
      const token = est.Public_Token__c || d.randomToken();
      const url = publicEstimateUrl(token, d.publicBaseUrl);
      const fields = {
        Version__c: version,
        Status__c: "Sent",
        Last_Sent_At__c: now.toISOString(),
        Last_Sent_Via__c: via,
        Public_Token__c: token,
        Public_Token_Expires_At__c: tokenExpires.toISOString(),
      };
      if (!est.Valid_Until__c || body?.validDays) fields.Valid_Until__c = validUntil.toISOString().slice(0, 10);
      const validUntilOut = fields.Valid_Until__c ?? est.Valid_Until__c ?? null;

      // The PDF of THIS version (D-072.5): rendered from the same model as the page,
      // stored at SUNDIAL/{estimateId}/estimate-v{n}.pdf so it sits in the estimate's
      // Files tab, and attached to the email below. Best-effort: a PDF failure is
      // reported (pdfKey null + deliveryDetail), never a reason to refuse the send —
      // the customer still gets the link, which is the document of record.
      const brand = brandFor(ctx);
      const docEstimate = { ...est, ...fields, Valid_Until__c: validUntilOut };
      let pdfBytes = null;
      let pdfKey = null;
      let pdfError = null;
      try {
        const model = buildEstimateModel({ estimate: docEstimate, lines, totals, brand, options: { mode: "customer", acceptUrl: url || undefined } });
        pdfBytes = await d.renderPdf(model);
        const key = estimatePdfKey(est.Id, version);
        await d.putObject({ key, body: pdfBytes, contentType: "application/pdf" });
        pdfKey = key;
      } catch (e) {
        pdfError = e?.message || String(e);
        console.error(`estimate send: PDF failed for ${est.Id} v${version}: ${pdfError}`);
        pdfBytes = null;
      }

      const entry = {
        version,
        sentAt: now.toISOString(),
        sentBy: userId,
        sentVia: via,
        total: totals.total,
        lines: lines
          .filter((l) => l.Stage__c !== "Removed")
          .map((l) => ({
            itemId: l.Price_Book_Item__c ?? null,
            desc: l.Description__c,
            qty: l.Quantity__c,
            unitPrice: l.Unit_Price__c,
            kind: l.Kind__c,
            stage: l.Stage__c,
          })),
        pdfKey,
      };
      let log = [];
      try {
        log = est.Version_Log__c ? JSON.parse(est.Version_Log__c) : [];
        if (!Array.isArray(log)) log = [];
      } catch {
        log = [];
      }
      log.push(entry);
      fields.Version_Log__c = JSON.stringify(log);
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
      } catch (e) {
        return sfError(cors, e, "estimate send");
      }
      await markStale(CACHE.estimate, [est.Id], tenantId);

      // Files-tab metadata row for the PDF — best-effort, after the record is updated
      // (the object is already in S3, and the Files tab lists S3 directly anyway).
      if (pdfKey) {
        try {
          const supabase = await d.getSupabaseClient();
          if (!(await findFileMetadataByKey(supabase, pdfKey))) {
            await registerFileMetadata(supabase, {
              s3Key: pdfKey,
              fileName: `estimate-v${version}.pdf`,
              tenantId,
              sfRecordId: est.Id,
              sfObjectType: ESTIMATE_SF_OBJECT,
              uploadedByUserId: userId ?? null,
              uploadedByUserName: "Sundial (estimate send)",
              fileSizeBytes: pdfBytes?.byteLength ?? null,
              mimeType: "application/pdf",
              category: "Estimate",
              subfolder: null,
            });
          }
        } catch (e) {
          console.error(`estimate send: file metadata register failed for ${pdfKey}: ${e?.message || e}`);
        }
      }

      // Delivery. Email now (SES, lib/email.js); SMS when Twilio lands — until then an
      // SMS/Both send is recorded and the office texts the link by hand. Every failure
      // mode is reported, never silent: the version is already recorded either way.
      let delivery = "recorded";
      let deliveryDetail = null;
      let recipient = null;
      if (via === "Email" || via === "Both") {
        if (!url) deliveryDetail = "SERVICE_PUBLIC_BASE_URL is not set on this Lambda, so no link could be built.";
        else if (!d.isEmailConfigured()) deliveryDetail = "EMAIL_FROM is not set on this Lambda (SES not wired).";
        else {
          let email = strOrNull(body?.to);
          if (!email && est.Sundial_Customer__c) {
            const cust = await d.sfQuery(
              `SELECT ${CUSTOMER_EMAIL_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(est.Sundial_Customer__c)}' ` +
                `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
            );
            email = strOrNull(cust?.[0]?.Primary_Email__c) || strOrNull(est.Primary_Email_at_Creation__c);
          }
          if (!email) deliveryDetail = "The customer has no email address on file.";
          else {
            const msg = buildEstimateEmail({ est, total: totals.total, url, brandName: brand.companyName, validUntil: validUntilOut });
            const attachments = pdfBytes
              ? [{ fileName: `${est.Name || "estimate"}-v${version}.pdf`, contentType: "application/pdf", content: pdfBytes }]
              : [];
            const sent = await d.sendEmail({ to: email, subject: msg.subject, html: msg.html, text: msg.text, attachments });
            if (sent.ok) {
              delivery = "email";
              recipient = email;
            } else deliveryDetail = `Email failed: ${sent.error}`;
          }
        }
      }
      if (via === "SMS" || via === "Both") {
        deliveryDetail = [deliveryDetail, "SMS is not live yet — text the link by hand."].filter(Boolean).join(" ");
      }
      if (pdfError) {
        deliveryDetail = [deliveryDetail, "The PDF could not be generated for this version (the link still works)."].filter(Boolean).join(" ");
      }

      await act(ctx, { event: EVENTS.ESTIMATE_SENT, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { version, via, delivery, recipient, deliveryDetail, total: totals.total, validUntil: validUntilOut, lineCount: entry.lines.length, pdfKey } });
      return jsonResponse(200, cors, {
        success: true,
        id: est.Id,
        version,
        total: totals.total,
        publicToken: token,
        publicUrl: url,
        validUntil: validUntilOut,
        pdfKey,
        pdfUrl: pdfKey ? publicUrlForKey(pdfKey) : null,
        delivery, // "email" (sent) | "recorded" (version bumped, nothing went out — see deliveryDetail)
        recipient,
        deliveryDetail,
      });
    },

    async approveEstimate({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Is_Template__c === true) return bad(cors, "TEMPLATE", "Templates cannot be approved.");
      const method = ["Online", "Verbal", "Signed", "Deposit Paid"].includes(body?.method) ? body.method : "Verbal";
      const { totals } = await recomputeAndStore(est, tenantId);
      const fields = {
        Status__c: "Approved",
        Approved_At__c: d.now().toISOString(),
        Approved_Version__c: Number(est.Version__c) || 0,
        Approved_Amount__c: totals.total,
        Approval_Method__c: method,
        Approved_By_Name__c: strOrNull(body?.name),
      };
      for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
        // Proposed lines become Approved; Removed/Completed untouched.
        const lines = await loadLines(est.Id, tenantId);
        for (const l of lines) {
          if (l.Stage__c === "Proposed") await d.sfUpdateRecord(LINE_SF_OBJECT, l.Id, { Stage__c: "Approved" });
        }
        await markStale(CACHE.line, lines.map((l) => l.Id), tenantId);
      } catch (e) {
        return sfError(cors, e, "estimate approve");
      }
      await markStale(CACHE.estimate, [est.Id], tenantId);
      await act(ctx, { event: EVENTS.ESTIMATE_APPROVED, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { method, approvedBy: fields.Approved_By_Name__c ?? null, version: fields.Approved_Version__c, amount: totals.total } });
      return jsonResponse(200, cors, { success: true, id: est.Id, approvedAmount: totals.total, approvedVersion: fields.Approved_Version__c });
    },

    async declineEstimate({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, {
          Status__c: "Declined",
          Declined_Reason__c: (strOrNull(body?.reason) || "").slice(0, 255) || null,
        });
      } catch (e) {
        return sfError(cors, e, "estimate decline");
      }
      await markStale(CACHE.estimate, [est.Id], tenantId);
      await act(ctx, { event: EVENTS.ESTIMATE_DECLINED, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { reason: strOrNull(body?.reason) } });
      return jsonResponse(200, cors, { success: true, id: est.Id });
    },

    async createJobFromEstimate({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Is_Template__c === true) return bad(cors, "TEMPLATE", "A template cannot become a job.");
      if (est.Service_Job__c) {
        return jsonResponse(409, cors, { error: "already_converted", code: "ESTIMATE_HAS_JOB", jobId: est.Service_Job__c });
      }
      const customer = await loadCustomer(est.Sundial_Customer__c, tenantId);
      if (!customer) return bad(cors, "ESTIMATE_NO_CUSTOMER", "The estimate has no customer; set one before creating a job.");
      let job;
      try {
        job = await createJobRecord({ customer, estimateId: est.Id, body: { job: { intakeChannel: "Estimate Conversion", ...(body?.job || {}) } }, tenantId });
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Service_Job__c: job.id });
      } catch (e) {
        return sfError(cors, e, "job create");
      }
      await markStale(CACHE.estimate, [est.Id], tenantId);
      await linkEstimateActivityToJob(d.getSupabaseClient, { tenantId, estimateSfId: est.Id, jobSfId: job.id });
      await act(ctx, { event: EVENTS.JOB_CREATED, recordType: "job", recordSfId: job.id, jobSfId: job.id, estimateSfId: est.Id, details: { fromEstimate: true, estimateNumber: est.Name ?? null, customerId: customer.Id } });
      return jsonResponse(201, cors, { success: true, jobId: job.id, estimateId: est.Id, rejectedFields: job.rejected });
    },

    async createJob({ ctx, body }) {
      const { tenantId, userId, cors } = ctx;
      // Path A: convert an existing estimate. Path B: quick-create estimate + job.
      if (body?.estimateId) {
        return H.createJobFromEstimate({ ctx, params: [String(body.estimateId)], body });
      }
      const r = await resolveCustomer(body, ctx, cors);
      if (!r.ok) return r.response;
      const { customer, created: customerCreated, warnings, events: customerEvents } = r;
      let est;
      try {
        est = await createEstimateRecord({ customer, body, tenantId, userId });
      } catch (e) {
        const resp = sfError(cors, e, "estimate create");
        if (customerCreated) resp.body = JSON.stringify({ ...JSON.parse(resp.body), customerCreated: true, customerId: customer.Id });
        return resp;
      }
      let job;
      try {
        job = await createJobRecord({ customer, estimateId: est.id, body, tenantId });
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.id, { Service_Job__c: job.id });
      } catch (e) {
        // Compensate: an estimate with no job is legal, but this one was never meant to
        // stand alone. Best-effort delete; report either way so nothing is silent.
        let estimateRemoved = false;
        try {
          await d.sfDeleteRecord(ESTIMATE_SF_OBJECT, est.id);
          estimateRemoved = true;
        } catch { /* leave it; the response says so */ }
        const resp = sfError(cors, e, "job create");
        resp.body = JSON.stringify({
          ...JSON.parse(resp.body),
          customerCreated,
          customerId: customer.Id,
          estimateId: estimateRemoved ? null : est.id,
          estimateRemoved,
        });
        return resp;
      }
      const lineResult = await addLinesToEstimate(est.id, tenantId, body?.lines);
      let template = null;
      if (body?.templateId) {
        template = await cloneTemplateLines(String(body.templateId), est.id, tenantId);
        if (template.error) warnings.push(`template ${body.templateId} not found — no lines added from it`);
      }
      const full = await loadEstimate(est.id, tenantId);
      const { totals } = await recomputeAndStore(full, tenantId);
      await flushEvents(ctx, customerEvents, { estimateSfId: est.id, jobSfId: job.id });
      await act(ctx, { event: EVENTS.JOB_CREATED, recordType: "job", recordSfId: job.id, jobSfId: job.id, estimateSfId: est.id, details: { quickCreate: true, customerId: customer.Id, customerCreated, linesCreated: lineResult.createdIds.length + (template?.count ?? 0), total: totals.total } });
      return jsonResponse(201, cors, {
        success: true,
        jobId: job.id,
        estimateId: est.id,
        customerId: customer.Id,
        customerCreated,
        linesCreated: lineResult.createdIds.length + (template?.count ?? 0),
        lineProblems: lineResult.problems,
        totals: totals.fields,
        rejectedFields: [...est.rejected, ...job.rejected],
        warnings,
      });
    },

    // --- price book ------------------------------------------------------------------
    async createItem({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const { fields, rejected, problems } = itemFieldsFromBody(body, { requireAll: true });
      if (problems.length) return bad(cors, "ITEM_INVALID", problems.join("; "), { rejectedFields: rejected });
      const clash = await d.sfQuery(
        `SELECT Id, Version__c FROM ${ITEM_SF_OBJECT} WHERE Item_Code__c = '${soqlEscapeString(fields.Item_Code__c)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' AND Is_Active__c = true LIMIT 1`
      );
      if (clash?.length) {
        return jsonResponse(409, cors, {
          error: "item_code_active",
          code: "ITEM_CODE_IN_USE",
          message: `An active version of ${fields.Item_Code__c} already exists — use new-version to change it.`,
          existingId: clash[0].Id,
        });
      }
      let created;
      try {
        created = await d.sfCreateRecord(ITEM_SF_OBJECT, { ...fields, Version__c: 1, Is_Active__c: true, Client__c: tenantId });
      } catch (e) {
        return sfError(cors, e, "item create");
      }
      await act(ctx, { event: EVENTS.ITEM_CREATED, recordType: "pricebookitem", recordSfId: created.id, details: { itemCode: fields.Item_Code__c, name: fields.Name, kind: fields.Kind__c, laborPrice: fields.Labor_Price__c ?? null, materialPrice: fields.Material_Price__c ?? null } });
      return jsonResponse(201, cors, { success: true, id: created.id, itemCode: fields.Item_Code__c, version: 1, rejectedFields: rejected });
    },

    async patchItem({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const item = await loadItem(params[0], tenantId);
      if (!item) return notFound(cors);
      const { fields, rejected, problems } = itemFieldsFromBody(body);
      if (problems.length) return bad(cors, "ITEM_INVALID", problems.join("; "));
      delete fields.Item_Code__c; // the code never changes on an existing version
      if (!Object.keys(fields).length) return bad(cors, "NO_FIELDS", "Nothing to update.", { rejectedFields: rejected });
      const refs = await countLinesReferencing(item.Id, tenantId);
      if (!inPlaceEditable(refs)) {
        return jsonResponse(409, cors, {
          error: "item_in_use",
          code: "ITEM_IN_USE",
          message: `${item.Item_Code__c} v${item.Version__c} is on ${refs} line(s); use new-version instead so history keeps its pricing.`,
          referencingLines: refs,
        });
      }
      try {
        await d.sfUpdateRecord(ITEM_SF_OBJECT, item.Id, fields);
      } catch (e) {
        return sfError(cors, e, "item update");
      }
      await markStale(CACHE.item, [item.Id], tenantId);
      await act(ctx, { event: EVENTS.ITEM_UPDATED, recordType: "pricebookitem", recordSfId: item.Id, details: { itemCode: item.Item_Code__c, version: item.Version__c, fields: diffFields(item, fields) } });
      return jsonResponse(200, cors, { success: true, id: item.Id, rejectedFields: rejected });
    },

    async newItemVersion({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const item = await loadItem(params[0], tenantId);
      if (!item) return notFound(cors);
      if (item.Is_Active__c !== true) {
        return jsonResponse(409, cors, { error: "not_active", code: "ITEM_NOT_ACTIVE", message: "Only the active version can be updated.", supersededBy: item.Superseded_By__c ?? null });
      }
      const { fields: edits, rejected, problems } = itemFieldsFromBody(body);
      if (problems.length) return bad(cors, "ITEM_INVALID", problems.join("; "));
      delete edits.Item_Code__c;
      const fields = newVersionFields(item, edits, tenantId);
      let created;
      try {
        created = await d.sfCreateRecord(ITEM_SF_OBJECT, fields);
        await d.sfUpdateRecord(ITEM_SF_OBJECT, item.Id, supersededFields(created.id));
      } catch (e) {
        return sfError(cors, e, "item new-version");
      }
      await markStale(CACHE.item, [item.Id], tenantId);
      await act(ctx, { event: EVENTS.ITEM_NEW_VERSION, recordType: "pricebookitem", recordSfId: created.id, details: { itemCode: item.Item_Code__c, fromVersion: item.Version__c, toVersion: fields.Version__c, previousId: item.Id, fields: diffFields(item, edits) } });
      return jsonResponse(201, cors, { success: true, id: created.id, previousId: item.Id, itemCode: item.Item_Code__c, version: fields.Version__c, rejectedFields: rejected });
    },

    async deactivateItem({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const item = await loadItem(params[0], tenantId);
      if (!item) return notFound(cors);
      try {
        await d.sfUpdateRecord(ITEM_SF_OBJECT, item.Id, { Is_Active__c: false });
      } catch (e) {
        return sfError(cors, e, "item deactivate");
      }
      await markStale(CACHE.item, [item.Id], tenantId);
      await act(ctx, { event: EVENTS.ITEM_DEACTIVATED, recordType: "pricebookitem", recordSfId: item.Id, details: { itemCode: item.Item_Code__c, version: item.Version__c } });
      return jsonResponse(200, cors, { success: true, id: item.Id });
    },

    // --- preview (read-only; the same renderer the hosted page / PDF / email use) ------
    async previewEstimate({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      const lines = await loadLines(est.Id, tenantId);
      const totals = computeTotals(lines.map(lineFromRecord), estimateFromRecord(est));
      // Brand block: per-tenant config when that surface lands (service-workflows.md
      // §12). Until then the document renders with the tenant slug as the name so the
      // layout can be reviewed; the real identity block is a GET-FROM-HARMON item.
      const { html, title } = renderEstimateDocument({ estimate: est, lines, totals, brand: brandFor(ctx), options: { mode: "preview" } });
      return jsonResponse(200, cors, { html, title, version: Number(est.Version__c) || 0 });
    },

    // --- activity feeds -----------------------------------------------------------------
    async jobActivity({ ctx, params, query }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const { rows, error } = await listActivity(d.getSupabaseClient, { tenantId, jobSfId: job.Id, limit: query?.limit, before: query?.before });
      if (error) return jsonResponse(502, cors, { error: "activity_read_failed", code: "ACTIVITY_READ_FAILED", message: error });
      return jsonResponse(200, cors, { jobId: job.Id, estimateId: job.Estimate__c ?? null, activity: rows });
    },
    async estimateActivity({ ctx, params, query }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      const { rows, error } = await listActivity(d.getSupabaseClient, { tenantId, estimateSfId: est.Id, limit: query?.limit, before: query?.before });
      if (error) return jsonResponse(502, cors, { error: "activity_read_failed", code: "ACTIVITY_READ_FAILED", message: error });
      return jsonResponse(200, cors, { estimateId: est.Id, jobId: est.Service_Job__c ?? null, activity: rows });
    },

    // --- Street View --------------------------------------------------------------------
    // { status: "ready", url } | { status: "none" } (no imagery) | { status: "unconfigured" }
    // (no secret yet) | { status: "no_address" }. `?refresh=1` re-asks Google (address fixed).
    async jobStreetView({ ctx, params, query }) {
      const { tenantId, cors } = ctx;
      if (!SF_ID_RE.test(params[0] || "")) return notFound(cors);
      const rows = await d.sfQuery(
        `SELECT Id, Address_at_Creation__c, Street_View_Image_Key__c FROM ${JOB_SF_OBJECT} ` +
          `WHERE Id = '${soqlEscapeString(params[0])}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
      );
      const job = rows?.[0];
      if (!job) return notFound(cors);
      const refresh = query?.refresh === "1" || query?.refresh === "true";
      const current = job.Street_View_Image_Key__c || null;
      if (!refresh && current === STREET_VIEW_NONE) return jsonResponse(200, cors, { status: "none" });
      if (!refresh && current) return jsonResponse(200, cors, { status: "ready", url: publicUrlForKey(current), key: current, cached: true });

      const address = (job.Address_at_Creation__c || "").trim();
      if (!address) return jsonResponse(200, cors, { status: "no_address" });

      let apiKey = null;
      try {
        apiKey = (await d.getSecret(STREET_VIEW_SECRET))?.apiKey || null;
      } catch (e) {
        if (!/ResourceNotFound/i.test(e?.name || e?.message || "")) console.error("street-view secret", e?.message);
      }
      if (!apiKey) return jsonResponse(200, cors, { status: "unconfigured" });

      // 1. Metadata first (free): is there an outdoor panorama for this address?
      const q = `location=${encodeURIComponent(address)}&source=outdoor&key=${encodeURIComponent(apiKey)}`;
      let meta;
      try {
        const r = await d.fetchUrl(`https://maps.googleapis.com/maps/api/streetview/metadata?${q}`);
        meta = await r.json();
      } catch (e) {
        console.error("street-view metadata", e?.message);
        return jsonResponse(502, cors, { error: "street_view_failed", code: "STREET_VIEW_FAILED", message: "Google did not answer." });
      }
      if (meta?.status !== "OK") {
        if (meta?.status === "ZERO_RESULTS" || meta?.status === "NOT_FOUND") {
          await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Street_View_Image_Key__c: STREET_VIEW_NONE });
          return jsonResponse(200, cors, { status: "none" });
        }
        console.error("street-view metadata status", meta?.status, meta?.error_message);
        return jsonResponse(502, cors, { error: "street_view_failed", code: "STREET_VIEW_FAILED", message: `Google said ${meta?.status || "nothing"}.` });
      }
      // 2. The still itself, by panorama id so it is the outdoor one metadata found.
      const key = streetViewKey(job.Id);
      try {
        const img = await d.fetchUrl(
          `https://maps.googleapis.com/maps/api/streetview?size=${STREET_VIEW_SIZE}&pano=${encodeURIComponent(meta.pano_id)}&fov=80&key=${encodeURIComponent(apiKey)}`
        );
        if (!img.ok) throw new Error(`HTTP ${img.status}`);
        const bytes = Buffer.from(await img.arrayBuffer());
        await d.putObject({ key, body: bytes, contentType: "image/jpeg" });
      } catch (e) {
        console.error("street-view image", e?.message);
        return jsonResponse(502, cors, { error: "street_view_failed", code: "STREET_VIEW_FAILED", message: "Couldn't fetch the image." });
      }
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Street_View_Image_Key__c: key });
      return jsonResponse(200, cors, { status: "ready", url: publicUrlForKey(key), key, cached: false, panoLocation: meta.location ?? null });
    },
  };

  /** The payer's email for a customer-billed document: the customer's current one, else the snapshot. */
  async function customerEmailFor(job, tenantId) {
    if (job?.Sundial_Customer__c) {
      const cust = await d.sfQuery(
        `SELECT ${CUSTOMER_EMAIL_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(job.Sundial_Customer__c)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
      );
      const e = strOrNull(cust?.[0]?.Primary_Email__c);
      if (e) return e;
    }
    return strOrNull(job?.Primary_Email_at_Creation__c);
  }
  Object.assign(H, createInvoiceHandlers(d, { loadEstimate, loadLines, act, markStale, brandFor, jsonResponse, bad, notFound, sfError, CACHE, customerEmailFor }));

  // Action key per route family (lib/access.js ACTION_SCOPES — all tenant-only).
  const ACTION_FOR = {
    createEstimate: "service.estimate.write", getEstimate: "service.estimate.write", patchEstimate: "service.estimate.write",
    addLine: "service.estimate.write", patchLine: "service.estimate.write", deleteLine: "service.estimate.write",
    addTemplate: "service.estimate.write", recalculate: "service.estimate.write", sendEstimate: "service.estimate.send",
    approveEstimate: "service.estimate.send", declineEstimate: "service.estimate.send",
    createJobFromEstimate: "service.job.create", createJob: "service.job.create",
    createItem: "service.pricebook.write", patchItem: "service.pricebook.write",
    newItemVersion: "service.pricebook.write", deactivateItem: "service.pricebook.write",
    jobActivity: "service.estimate.write", estimateActivity: "service.estimate.write",
    previewEstimate: "service.estimate.write", jobStreetView: "service.estimate.write",
    getJobInvoice: "service.estimate.write", getInvoice: "service.estimate.write", previewInvoice: "service.estimate.write",
    issueInvoice: "service.invoice.write", recordPayment: "service.invoice.write", sendInvoice: "service.invoice.write", voidInvoice: "service.invoice.write",
  };

  return async function handler(event) {
    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

    const route = matchRoute(method, event?.rawPath || event?.path || "");
    if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });

    let identity;
    try {
      identity = await d.resolveIdentity(headers["authorization"]);
    } catch (err) {
      const m = mapIdentityError(err?.code);
      if (m) return jsonResponse(m.status, cors, m.body);
      console.error("identity error:", err?.message || err);
      return jsonResponse(500, cors, { error: "server_error" });
    }
    const tenantId = identity?.tenantId;
    if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    const denied = assertAction(ACTION_FOR[route.name], alwaysEnforcedAccess(identity));
    if (denied) return jsonResponse(denied.status, cors, denied.body);

    let body = {};
    if (method !== "GET" && method !== "DELETE") {
      const parsed = parseJsonBody(event);
      if (!parsed.ok && event?.body) return bad(cors, "INVALID_BODY", "Body must be JSON.");
      body = parsed.ok ? parsed.data : {};
    }

    try {
      const u = identity?.user ?? {};
      const ctx = {
        tenantId,
        tenantSlug: identity?.tenantSlug ?? null,
        userId: u.id ?? null,
        actor: { id: u.id ?? null, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || null },
        cors,
      };
      return await H[route.name]({ ctx, params: route.params, body, query: event?.queryStringParameters || {} });
    } catch (err) {
      console.error(`service-estimate ${route.name} error:`, err?.sfBody || err?.message || err);
      return jsonResponse(500, cors, { error: "server_error", route: route.name });
    }
  };
}

export const handler = createHandler();
