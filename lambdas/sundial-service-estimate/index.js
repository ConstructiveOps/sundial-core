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
//   POST   /service/customers                       the Service module's New Customer / Add to Service (D-075): select-or-create,
//                                                   duplicate guard, tagged Service, Service_Stage__c = New — no estimate, no job
//   POST   /service/price-book-items                create version 1
//   PATCH  /service/price-book-items/{id}           in-place edit (only while unreferenced)
//   POST   /service/price-book-items/{id}/new-version   the "Update" clone
//   POST   /service/price-book-items/{id}/deactivate
//   GET    /service/estimates/{id}/preview          read-only rendered document (what the customer sees)
//   GET    /service/estimates/{id}/pdf              the PDF as it stands now, before any send: DRAFT / PREVIEW watermark,
//                                                   nothing stored, no version, no status (2026-10-22)
//   POST   /service/estimates/{id}/lines/reorder    { lineIds } → Sort_Order__c 1..n (2026-10-22)
//   GET    /service/jobs/{id}/activity              the job's activity feed (newest first)
//   GET    /service/jobs/{id}/street-view           the house: Google Street View still, fetched once, cached in S3
//   GET    /service/address/suggest?q=&session=     address lookup for customer create (Google Places, key server-side; address.js)
//   GET    /service/address/place/{placeId}?session=  → the picked address as street / city / state / postalCode
//   POST   /service/jobs/{id}/invoice               issue the job's invoice (estimate lines frozen)   ┐
//   GET    /service/jobs/{id}/invoice               the job's current invoice + payments             │
//   GET    /service/invoices/{id}                   one invoice + payments                           │ invoice.js
//   GET    /service/invoices/{id}/preview           the invoice document (HTML)                      │
//   POST   /service/invoices/{id}/payments          record a check / ACH / remittance / refund       │
//   POST   /service/jobs/{id}/payments              a check / ACH deposit before the invoice (2026-10-27) │
//   POST   /service/invoices/{id}/send              email the PDF to the payer                       │
//   POST   /service/invoices/{id}/void              void with a reason (reissue = "-2")              ┘
//   GET    /service/jobs/{id}/labor                 completed calls + clock hours + billing state    ┐
//   POST   /service/jobs/{id}/labor                 bill / unbill calls, overtype hours and rates     │ labor.js
//   POST   /service/labor/default-rate              a tech's Hourly_Bill_Rate__c                     ┘
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
// lib/email.js (SES; EMAIL_FROM / EMAIL_REPLY_TO / EMAIL_CONFIG_SET) and / or texts it
// through lib/sms-send.js (the job's conversation; 2026-10-16, D-072 amendment 12). Who
// it goes to is lib/send-to.js: the office's send box, else the payer, else the customer —
// nothing to send to is a 400 RECIPIENT_REQUIRED before the version is recorded. Every way
// a message can NOT go out once recorded (no base URL, SES / Twilio not configured, a
// provider error) comes back in deliveryDetail; `Both` reports each half on its own.
// The customer side of that link is lambdas/sundial-service-public (view / accept /
// decline by token, no login).
//
// SALES TAX (D-083, lib/tax-zones.js): Acumatica's own zones / rates / categories, copied
// daily into Supabase. A job is stamped with its zone (Tax_Zone_Code__c / _Label__c) from
// the customer's city at creation — never a guess: no match = blank, "Tax zone needed",
// and invoice issue refuses (400 TAX_ZONE_REQUIRED) until the office sets it
// (POST /service/jobs/{id}/tax-zone). The estimate's Tax_Rate__c / Tax_Jurisdiction__c are
// OUTPUTS of that zone (the job's, else the customer's city), no longer typed or defaulted.
//   GET    /service/tax-zones                      the office picker (retail zones, today's rates)
//   POST   /service/jobs/{id}/tax-zone             { zoneCode } — set / correct the job's zone
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
import { canAction } from "../../lib/access.js";
import { renderEstimateDocument, buildEstimateModel, DEFAULT_BRAND } from "../../lib/estimate-document.js";
import { renderEstimatePdf as realRenderEstimatePdf } from "../../lib/estimate-pdf.js";
import { renderJobReportPdf as realRenderJobReportPdf } from "../../lib/job-report-pdf.js";
import { resizeJpegForReport as realResizeJpegForReport } from "../../lib/image-resize.js";
import { createSmsSender } from "../../lib/sms-send.js";
import { createNotifier } from "../../lib/notify.js";
import { alertAssigned, alertUnassignedCustomer } from "../../lib/service-intake-alerts.js";
// 2026-10-22: the customer's feed gets the server's own intake / assignment lines (D-084);
// a new follow-up date ticks Follow-up needed.
import { commentOnCustomerWrite, userDisplayName } from "../../lib/intake-comment.js";
import { FOLLOW_UP_DATE_FIELD, applyFollowUpFlag } from "../../lib/follow-up.js";
import { createBrandLoader, brandPublicUrl } from "../../lib/brand.js";
import { isPrimaryTenant } from "../../lib/tenant-guard.js";
import { customerDisplayName } from "../../lib/customer-name.js";
import { resolveBillTo, billToCustomerLoader, BILL_TO_SELF, BILL_TO_CUSTOMER_SELECT } from "../../lib/bill-to.js";
import { sendDefaults, resolveRecipients, viaFrom, needsEmail, needsPhone } from "../../lib/send-to.js";
import { costWriteGate, stripCost, stripMarkup, markupWriteGate, COSTING_READ, COSTING_WRITE } from "../../lib/cost-gate.js";
import {
  buildKey,
  listRecordFiles,
  publicUrlForKey,
  registerFileMetadata,
  findFileMetadataByKey,
  S3_BUCKET,
  S3_REGION,
} from "../../lib/file-access.js";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
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
import { computeTotals, lineFromRecord, estimateFromRecord, withStoredTotals, showsStoredTotals } from "./totals.js";
import {
  estimateTaxContext,
  loadTaxTables as realLoadTaxTables,
  resolveTaxZoneIn,
  headlineRate,
} from "../../lib/tax-zones.js";
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
  LINE_DESCRIPTION_FALLBACK_MAX,
  linkLineToItem,
  cloneLineFields,
  withDerivedTaxable,
} from "./pricebook.js";

import { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT, ESTIMATE_SELECT } from "./fields.js";
import { createInvoiceHandlers, createMoneyCore } from "./invoice.js";
import { createStripeHandlers } from "./stripe.js";
import { createLaborHandlers, CALL_SF_OBJECT } from "./labor.js";
import { createReportHandlers } from "./report.js";
import { createClubHandlers } from "./club.js";
import { createAddressHandlers } from "./address.js";
export { ESTIMATE_SF_OBJECT, JOB_SF_OBJECT, ESTIMATE_SELECT };

// The module's product-history tag on the customer (D-072 amendment). "Service" is a
// Sundial product category, not a Harmon value — Roofing / Commercial pass their own.
export const PROJECT_TYPE_TAG = "Service";
/** Customer_Type__c (multi-select, 2026-09-19): the department tag the service module sets / adds — same value, second field. */
export const CUSTOMER_TYPE_FIELD = "Customer_Type__c";
// The lead source on a customer the Service module creates (2026-10-16): the org's picklist.
export const LEAD_SOURCE_FIELD = "Lead_Source__c";
// D-075: the Service module's own pipeline on the customer (docs/service-customer-layout.md).
export const SERVICE_STAGE_FIELD = "Service_Stage__c";
/** Archived__c (2026-10-02): off every Service list by default; a reuse of the customer clears it. */
export const ARCHIVED_FIELD = "Archived__c";
/**
 * The intake questions (Harmon, 2026-10-02): asked on every New Customer / Estimate / Job popup,
 * written on the customer — created or existing. Body key → Sundial_Customer__c field. Each
 * picklist is describe-guarded: a value the org lacks is a warning, never a failed create.
 */
export const INTAKE_FIELDS = Object.freeze({
  systemOwnership: "System_Ownership__c",
  propertyType: "Property_Type__c",
  existingHarmonSystem: "Existing_Harmon_System__c",
  inverterManufacturer: "Inverter_Manufacturer__c",
  // Free text (D-081, 2026-10-07), asked right after the inverter: what the customer's
  // warranties are and with whom. Written like Description__c, no picklist check.
  warrantyNotes: "Warranty_Notes__c",
  typeOfService: "Type_of_Service__c",
  description: "Description__c",
  nextStep: "Next_Step__c",
  serviceClubInterest: "Service_Club_Interest__c",
});
export const SERVICE_STAGE_NEW = "New";
export const SERVICE_REQUEST_TYPE_FIELD = "Service_Request_Type__c";

// Tenant settings on Sundial_Tenant__c (2026-10-05, the first of that surface — fields Tim
// adds in Setup, every one describe-guarded so an org without them simply has no default):
//   Labor_Burden_Percent__c      Percent — a tech's burdened cost = Hourly_Cost_Rate__c × (1 + this)
// (Default_Tax_Rate__c / Default_Tax_Jurisdiction__c were read here until D-083: tax now comes
// from the job's Acumatica zone, never a tenant-wide default. The fields may stay in the org.)
export const TENANT_SF_OBJECT_SETTINGS = "Sundial_Tenant__c";
export const TENANT_SETTINGS_FIELDS = Object.freeze({
  laborBurdenPercent: "Labor_Burden_Percent__c",
});
/** The job fields D-083 stamps (Setup: Text(20) / Text(80)). */
export const TAX_ZONE_CODE_FIELD = "Tax_Zone_Code__c";
export const TAX_ZONE_LABEL_FIELD = "Tax_Zone_Label__c";
// Tenant config placeholders (service-workflows.md §12). GET FROM HARMON: validity days, default template.
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
// The send box's records (lib/send-to.js) double as the document's payer (the "Bill to" block
// needs the address and the "Attn:" contact), so one read serves both.
const RECIPIENT_RECORD_SELECT = `${BILL_TO_CUSTOMER_SELECT}, Primary_Email__c, Primary_Phone__c`;

/** Plain, deliverable email — the link is the point; the document lives on the page. */
/** The text that carries the estimate link (D-072 amendment 12) — one short SMS. */
export function buildEstimateText({ est, total, url, brandName }) {
  const number = est?.Name || "your estimate";
  const who = brandName ? ` from ${brandName}` : "";
  const money = Number.isFinite(Number(total)) && total !== null ? ` (${Number(total).toLocaleString("en-US", { style: "currency", currency: "USD" })})` : "";
  return `Your estimate ${number}${who}${money} is ready to view and approve: ${url}`.slice(0, 1600);
}

export function buildEstimateEmail({ est, total, url, brandName, validUntil, cardOnFile = false }) {
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
    cardOnFile ? "" : "On the same page you can pay your deposit or keep a card on file for the work — your card goes straight to Stripe; we never see the number.",
    "Approving lets us get the work scheduled. Questions? Just reply to this email.",
  ].filter((l) => l !== null && l !== "").join("\n");
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;max-width:560px">
  <p>Hello${est.Customer_Name_at_Creation__c ? ` ${esc(est.Customer_Name_at_Creation__c)}` : ""},</p>
  <p>Your estimate <strong>${esc(number)}</strong>${esc(who)} is ready${money ? ` (<strong>${esc(money)}</strong>)` : ""}.</p>
  <p style="margin:24px 0"><a href="${esc(url)}" style="background:#1F3864;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">View and approve your estimate</a></p>
  ${validLine ? `<p style="color:#52525b">${esc(validLine)}</p>` : ""}
  ${cardOnFile ? "" : `<p style="color:#52525b">On the same page you can pay your deposit or keep a card on file for the work — your card goes straight to Stripe; we never see the number.</p>`}
  <p style="color:#52525b">Approving lets us get the work scheduled. Questions? Just reply to this email.</p>
  <p style="color:#a1a1aa;font-size:12px">If the button doesn't work, copy this link: ${esc(url)}</p>
</div>`;
  return { subject, text, html };
}

const CACHE = Object.freeze({
  estimate: "sundial_estimate_cache",
  job: "sundial_service_job_cache",
  line: "sundial_service_line_cache",
  call: "sundial_service_call_cache",
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
  // taxRate / taxJurisdiction are no longer typed (D-083): they are the zone's, written by
  // recomputeAndStore. A body that still sends them gets them back in rejectedFields.
  depositRequired: ["Deposit_Required__c", (v) => v === true],
  depositType: ["Deposit_Type__c", (v) => v],
  depositValue: ["Deposit_Value__c", numOrNull],
  scopeSummary: ["Scope_Summary__c", strOrNull],
  // The service address (2026-09-18): a snapshot the office may correct — a typo, a second
  // property, a move. A Flow mirrors it job <-> estimate; the customer hub is untouched.
  address: ["Address_at_Creation__c", strOrNull],
  validUntil: ["Valid_Until__c", strOrNull],
  soldById: ["Sold_By__c", strOrNull],
  templateName: ["Template_Name__c", strOrNull],
  originatingSolarId: ["Originating_Solar_Project__c", strOrNull],
  originatingRoofingId: ["Originating_Roofing_Project__c", strOrNull],
  originatingCommercialId: ["Originating_Commercial_Project__c", strOrNull],
});

// The estimate's Bill To (D-081 amendment 2) is not a plain field: billToType /
// billToCustomerId go through lib/bill-to.js resolveBillTo (estimateBillTo), so the generic
// translate never sees them and never lists them as rejected.
const ESTIMATE_BILL_TO_KEYS = ["billToType", "billToCustomerId"];
function withoutBillToKeys(body) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  for (const k of [...ESTIMATE_BILL_TO_KEYS, "billToName"]) delete out[k];
  return out;
}

const JOB_CREATE_FIELDS = Object.freeze({
  issueDescription: ["Issue_Description__c", strOrNull],
  priority: ["Priority__c", (v) => v],
  serviceType: ["Service_Type__c", (v) => v],
  systemOwnership: ["System_Ownership__c", (v) => v],
  intakeChannel: ["Intake_Channel__c", (v) => v],
  intakeDate: ["Intake_Date__c", strOrNull],
  assignedToId: ["Assigned_To__c", strOrNull],
  // Bill To (D-081): the type says what kind of payer, billToCustomerId says who; both are
  // decided by lib/bill-to.js resolveBillTo BEFORE anything is created (jobBillTo below).
  // billToName is no longer accepted — the name is derived from the paying customer.
  billToType: ["Bill_To_Type__c", (v) => v],
  billToCustomerId: ["Bill_To_Customer__c", strOrNull],
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
/** The price-book cost rule (lib/cost-gate.js) for this caller: blank cost keys dropped, a value refused. */
function itemCostGate(ctx, body) {
  return costWriteGate("pricebookitem", body, ctx?.can ? ctx.can(COSTING_WRITE) === true : false);
}
function costForbidden(cors, gate) {
  return jsonResponse(403, cors, { error: "forbidden", code: gate.code, message: gate.message, fields: gate.fields });
}
/** The markup rule (lib/cost-gate.js, 2026-10-16) for this caller: blank markup keys dropped, a value refused. */
function markupGate(ctx, body) {
  return markupWriteGate(body, ctx?.can ? ctx.can(COSTING_WRITE) === true : false);
}
/**
 * The markup is a margin number (2026-10-16, Harmon): hidden like cost from anyone without
 * service.costing.read, on EVERY response this Lambda sends a signed-in user — the estimate
 * record, totals, totals.fields, the add-line / patch / club / labor responses alike — so no
 * route can forget it. The markup is still applied; only the numbers are not shown.
 */
export function withoutMarkup(response) {
  if (!response?.body || typeof response.body !== "string") return response;
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return response; // not JSON (never the case today) — nothing to strip
  }
  return { ...response, body: JSON.stringify(stripMarkup(parsed)) };
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
  ["POST", /^\/service\/customers\/?$/, "createServiceCustomer"], // the Service module's own New Customer (D-075)
  ["POST", /^\/service\/price-book-items\/?$/, "createItem"],
  ["PATCH", /^\/service\/price-book-items\/([^/]+)\/?$/, "patchItem"],
  ["POST", /^\/service\/price-book-items\/([^/]+)\/new-version\/?$/, "newItemVersion"],
  ["POST", /^\/service\/price-book-items\/([^/]+)\/deactivate\/?$/, "deactivateItem"],
  ["GET", /^\/service\/estimates\/([^/]+)\/preview\/?$/, "previewEstimate"],
  ["GET", /^\/service\/estimates\/([^/]+)\/pdf\/?$/, "estimatePdf"], // the PDF as it stands, before a send (2026-10-22)
  ["POST", /^\/service\/estimates\/([^/]+)\/lines\/reorder\/?$/, "reorderLines"], // the office's line order (2026-10-22)
  ["GET", /^\/service\/jobs\/([^/]+)\/activity\/?$/, "jobActivity"],
  ["GET", /^\/service\/jobs\/([^/]+)\/street-view\/?$/, "jobStreetView"],
  ["GET", /^\/service\/address\/suggest\/?$/, "suggestAddress"], // address lookup for customer create (address.js, 2026-09-22)
  ["GET", /^\/service\/address\/place\/([^/]+)\/?$/, "resolveAddress"],
  ["GET", /^\/service\/tax-zones\/?$/, "listTaxZones"], // the office's zone picker (D-083)
  ["POST", /^\/service\/jobs\/([^/]+)\/tax-zone\/?$/, "setJobTaxZone"], // set / correct a job's zone (D-083)
  ["GET", /^\/service\/jobs\/([^/]+)\/report\/?$/, "getReport"], // the customer's job report (report.js, D-072 am. 10)
  ["PUT", /^\/service\/jobs\/([^/]+)\/report\/?$/, "saveReport"],
  ["GET", /^\/service\/jobs\/([^/]+)\/report\/preview\/?$/, "previewReport"],
  ["POST", /^\/service\/jobs\/([^/]+)\/report\/prepare\/?$/, "prepareReport"], // warm the PDF's photo cache before a send (2026-10-12)
  ["POST", /^\/service\/jobs\/([^/]+)\/report\/send\/?$/, "sendReport"],
  ["POST", /^\/service\/estimates\/([^/]+)\/unlock\/?$/, "unlockEstimate"], // reopen an invoiced estimate (2026-09-30)
  ["POST", /^\/service\/jobs\/([^/]+)\/invoice\/?$/, "issueInvoice"],
  ["GET", /^\/service\/jobs\/([^/]+)\/invoice\/?$/, "getJobInvoice"],
  ["GET", /^\/service\/invoices\/report\/?$/, "invoiceReport"], // the week's invoices for accounting (2026-10-01) — before /{id}
  ["GET", /^\/service\/invoices\/([^/]+)\/preview\/?$/, "previewInvoice"],
  ["GET", /^\/service\/invoices\/([^/]+)\/?$/, "getInvoice"],
  ["POST", /^\/service\/invoices\/([^/]+)\/payments\/?$/, "recordPayment"],
  ["POST", /^\/service\/jobs\/([^/]+)\/payments\/?$/, "recordJobDeposit"], // a deposit before the invoice exists (2026-10-27)
  ["POST", /^\/service\/invoices\/([^/]+)\/send\/?$/, "sendInvoice"],
  ["POST", /^\/service\/invoices\/([^/]+)\/void\/?$/, "voidInvoice"],
  ["GET", /^\/service\/jobs\/([^/]+)\/labor\/?$/, "getLabor"],
  ["POST", /^\/service\/jobs\/([^/]+)\/labor\/?$/, "saveLabor"],
  ["POST", /^\/service\/labor\/default-rate\/?$/, "setDefaultRate"],
  ["POST", /^\/service\/labor\/cost-rate\/?$/, "setDefaultCostRate"],
  ["GET", /^\/service\/labor\/rates\/?$/, "listRates"], // the rate sheet (2026-10-05)
  ["GET", /^\/service\/jobs\/([^/]+)\/costing\/?$/, "getCosting"],
  ["GET", /^\/service\/estimates\/([^/]+)\/activity\/?$/, "estimateActivity"],
  ["POST", /^\/service\/tech\/calls\/([^/]+)\/estimate-lines\/?$/, "techAddLines"], // the tech app (service.tech.self)
  ["GET", /^\/service\/tech\/jobs\/([^/]+)\/street-view\/?$/, "techJobStreetView"], // the tech app (service.tech.read): the house, read-only
  // Stripe (D-072 amendment 8, stripe.js): the office's charge, and Stripe's own calls (no login).
  ["POST", /^\/service\/invoices\/([^/]+)\/charge\/?$/, "chargeInvoiceRoute"],
  ["POST", /^\/webhooks\/stripe\/([^/]+)\/?$/, "stripeWebhook"],
  // The office's card on file (amendment 11, 2026-09-28): status, Stripe's card page, the customer link, a charge.
  ["GET", /^\/service\/jobs\/([^/]+)\/card\/?$/, "jobCard"],
  ["POST", /^\/service\/jobs\/([^/]+)\/card-session\/?$/, "jobCardSession"],
  ["POST", /^\/service\/jobs\/([^/]+)\/card-link\/?$/, "jobCardLink"],
  ["POST", /^\/service\/jobs\/([^/]+)\/charge\/?$/, "jobCharge"],
  // Service Club (D-073, club.js). Public: the tenant slug is in the URL, no login.
  ["GET", /^\/public\/club\/([^/]+)\/plans\/?$/, "clubPlans"],
  ["POST", /^\/public\/club\/([^/]+)\/join\/?$/, "clubJoin"],
  ["GET", /^\/public\/club\/([^/]+)\/joined\/?$/, "clubJoined"],
  ["POST", /^\/public\/club\/([^/]+)\/truck-roll\/?$/, "clubTruckRoll"],
  ["POST", /^\/public\/club\/([^/]+)\/request\/?$/, "clubRequest"],
  ["POST", /^\/public\/club\/([^/]+)\/manage\/?$/, "clubManage"],
  // Office.
  ["GET", /^\/service\/club\/plans\/?$/, "clubPlansOffice"],
  ["PATCH", /^\/service\/club\/plans\/([^/]+)\/?$/, "clubPatchPlan"],
  ["GET", /^\/service\/club\/memberships\/?$/, "clubMemberships"],
  ["POST", /^\/service\/club\/memberships\/?$/, "clubCreateMembership"],
  ["POST", /^\/service\/club\/memberships\/([^/]+)\/cancel\/?$/, "clubCancel"],
  ["POST", /^\/service\/club\/memberships\/([^/]+)\/solarfacts\/?$/, "clubResendSolarFacts"],
  ["GET", /^\/service\/club\/report\/?$/, "clubReport"],
  ["GET", /^\/service\/club\/customers\/([^/]+)\/?$/, "clubCustomer"],
  ["POST", /^\/service\/estimates\/([^/]+)\/apply-plan-discount\/?$/, "applyPlanDiscount"],
];
/** Routes with no bearer token: the Stripe webhook (signature-gated) and the club's public pages. */
export const PUBLIC_ROUTES = new Set(["stripeWebhook", "clubPlans", "clubJoin", "clubJoined", "clubTruckRoll", "clubRequest", "clubManage"]);

export function matchRoute(method, path) {
  // Strip a stage prefix ("/prod/service/...") if the gateway passes one.
  const p = (path || "").replace(/^\/[^/]+(?=\/(service|webhooks|public)\/)/, "");
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
// The key carries a timestamp (2026-09-18): the S3 URL is what the browser caches, so a
// re-fetch after an address change MUST land at a new URL or the office keeps seeing the
// old house. The previous file is deleted best-effort when a new one is written.
export const streetViewKey = (jobId, at = new Date()) =>
  buildKey(jobId, `street-view-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(2).toString("hex")}.jpg`);
export const isStreetViewKey = (key) => /\/street-view(-\d{8}T\d{6}Z-[0-9a-f]{4})?\.jpg$/.test(String(key || ""));

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
    renderReportPdf: realRenderJobReportPdf,
    resizeImage: realResizeJpegForReport, // the report PDF's photos, shrunk for the page (2026-10-12)
    putObject: async ({ key, body, contentType }) =>
      s3().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType })),
    // The job report reads the job's photos back out of S3 for the PDF, and lists the job's folder for the picker.
    getObject: async ({ key }) => {
      const r = await s3().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      return { bytes: new Uint8Array(await r.Body.transformToByteArray()), contentType: r.ContentType ?? null };
    },
    listFiles: async (recordId) => listRecordFiles(s3(), recordId),
    deleteObject: async ({ key }) => s3().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })),
    now: () => new Date(),
    randomToken: () => randomBytes(24).toString("base64url"),
    getSecret: realGetSecret,
    fetchUrl: (url, init) => fetch(url, init), // Street View (GET) and Stripe (POST) share it
    ...deps,
  };
  // The tax tables (D-083): Supabase, cached per warm container. Tests inject their own.
  if (!d.loadTaxTables) d.loadTaxTables = (slug) => realLoadTaxTables(slug, { getSupabaseClient: d.getSupabaseClient });
  // Notifications (D-074): the office's bell for money + club + website events (stripe.js, club.js).
  if (!d.notifier) d.notifier = createNotifier({ getSupabaseClient: d.getSupabaseClient, getSecret: d.getSecret, now: d.now, env: process.env, ...(d.broadcast ? { broadcast: d.broadcast } : {}) });

  // The tenant's brand on every document (2026-09-24, lib/brand.js): Secrets Manager
  // `sundial/brand` keyed by slug — logo, identity lines, the terms and Service Club links.
  // The dispatcher warms it (with the logo bytes, for the PDFs) before a handler runs, so
  // `brandFor(ctx)` stays synchronous for the many callers that hand it to a builder.
  // Unconfigured: SERVICE_BRAND_NAME, else the tenant slug, so the layout can be reviewed.
  if (!d.brands) d.brands = createBrandLoader({ getSecret: d.getSecret, fetchUrl: d.fetchUrl, env: { ...process.env, ...(d.brandName ? { SERVICE_BRAND_NAME: d.brandName } : {}) } });
  // SERVICE_BRAND_NAME (d.brandName) is the PRIMARY tenant's name (D-078): the un-warmed
  // fallback below hands it to the primary tenant only. Any other tenant falls through
  // to its own slug, never to somebody else's company name.
  const brandFor = (ctx) => {
    const b = ctx?.brand ?? d.brands.cached(ctx?.tenantSlug ?? null) ?? { ...DEFAULT_BRAND, companyName: isPrimaryTenant(ctx?.tenantSlug) ? d.brandName || "" : "" };
    if (!b.companyName) b.companyName = ctx?.tenantSlug ? ctx.tenantSlug.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
    return b;
  };
  // WHERE THIS TENANT'S CUSTOMER PAGES LIVE (D-078). SERVICE_PUBLIC_BASE_URL
  // (d.publicBaseUrl) is one address per Lambda and it is the PRIMARY tenant's: the
  // primary tenant gets exactly that, as before. Any other tenant gets the `publicUrl`
  // (else `portalUrl`) of its own brand block — already warmed by the dispatcher for
  // this request, so this stays synchronous and reads nothing new — or "" when it has
  // none, which every caller already treats as "no link can be built". Never the
  // primary tenant's address: an estimate, report, pay or club link must open the
  // tenant's own site.
  const publicBaseFor = (ctx) => {
    if (isPrimaryTenant(ctx?.tenantSlug)) return d.publicBaseUrl;
    return brandPublicUrl(ctx?.brand ?? d.brands.cached(ctx?.tenantSlug ?? null)).replace(/\/+$/, "");
  };
  /** Why no customer link could be built — names the right knob for the tenant it is about. */
  const noPublicUrlDetail = (ctx) =>
    isPrimaryTenant(ctx?.tenantSlug)
      ? "SERVICE_PUBLIC_BASE_URL is not set on this Lambda, so no link could be built."
      : "This account has no public page address configured (PORTAL_URL_NOT_CONFIGURED: add publicUrl or portalUrl to its sundial/brand block), so no link could be built.";
  const warmBrand = async (tenantSlug) => {
    try {
      await d.brands.brandFor({ tenantSlug }, { withLogo: true });
    } catch (e) {
      console.error("brand warm:", e?.message || e);
    }
  };

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
  /**
   * The tenant's settings (TENANT_SETTINGS_FIELDS), each null when the org lacks the field
   * or the tenant left it blank; `missing` names the fields the org does not have yet.
   * Cached with the describes (DESCRIBE_TTL_MS) — one tenant row read per cold start.
   */
  const tenantSettingsCache = new Map();
  async function tenantSettings(tenantId) {
    const hit = tenantSettingsCache.get(tenantId);
    if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.value;
    const value = { laborBurdenPercent: null, missing: [] };
    const present = [];
    for (const [key, field] of Object.entries(TENANT_SETTINGS_FIELDS)) {
      const exists = await fieldExists(TENANT_SF_OBJECT_SETTINGS, field);
      if (exists) present.push([key, field]);
      else value.missing.push(field);
    }
    if (present.length && tenantId) {
      try {
        const rows = await d.sfQuery(`SELECT ${present.map(([, f]) => f).join(", ")} FROM ${TENANT_SF_OBJECT_SETTINGS} WHERE Id = '${soqlEscapeString(tenantId)}' LIMIT 1`);
        const row = rows?.[0] || {};
        for (const [key, field] of present) {
          const v = row[field];
          value[key] = v == null || v === "" ? null : Number(v);
        }
      } catch (e) {
        console.error("tenant settings read failed:", e?.message || e);
      }
    }
    tenantSettingsCache.set(tenantId, { at: Date.now(), value });
    return value;
  }
  /** Is this field in the org? (describe-guarded, like picklistValues — `null` when describe failed) */
  async function fieldExists(sfObject, field) {
    let hit = describeCache.get(sfObject);
    if (!hit || Date.now() - hit.at > DESCRIBE_TTL_MS) {
      try {
        hit = { at: Date.now(), meta: await d.describeObject(sfObject) };
        describeCache.set(sfObject, hit);
      } catch (e) {
        console.error("describe failed:", sfObject, e?.message || e);
        return null;
      }
    }
    return (hit.meta?.fields || []).some((x) => x.name === field);
  }

  /**
   * How long `Sundial_Service_Line__c.Description__c` is in THIS org (2026-10-16): the
   * builders refuse longer text instead of cutting it. The fallback (255, the field's
   * original Text length) only applies when the describe cannot be read.
   */
  async function lineDescriptionMax() {
    let hit = describeCache.get(LINE_SF_OBJECT);
    if (!hit || Date.now() - hit.at > DESCRIBE_TTL_MS) {
      try {
        hit = { at: Date.now(), meta: await d.describeObject(LINE_SF_OBJECT) };
        describeCache.set(LINE_SF_OBJECT, hit);
      } catch (e) {
        console.error("describe failed:", LINE_SF_OBJECT, e?.message || e);
        return LINE_DESCRIPTION_FALLBACK_MAX;
      }
    }
    const len = Number((hit.meta?.fields || []).find((x) => x.name === "Description__c")?.length);
    return len > 0 ? len : LINE_DESCRIPTION_FALLBACK_MAX;
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

  // --- sales tax (D-083, lib/tax-zones.js) -----------------------------------------
  // The tables are keyed by tenant SLUG; most helpers here carry the tenant's Salesforce id.
  // The dispatcher remembers each id's slug; anything else (the public club pages pass their
  // own) is looked up once.
  const slugByTenant = new Map();
  async function slugFor(tenantId) {
    if (!tenantId) return null;
    if (slugByTenant.has(tenantId)) return slugByTenant.get(tenantId);
    let slug = null;
    try {
      const rows = await d.sfQuery(`SELECT Name FROM Sundial_Tenant__c WHERE Id = '${soqlEscapeString(tenantId)}' LIMIT 1`);
      slug = rows?.[0]?.Name ?? null;
    } catch (e) {
      console.error("tenant slug read failed:", e?.message || e);
    }
    if (slug) slugByTenant.set(tenantId, slug);
    return slug;
  }
  async function taxTablesFor(tenantId) {
    return d.loadTaxTables(await slugFor(tenantId));
  }
  /** The estimate's tax context on `date` (default today). See lib/tax-zones.js estimateTaxContext. */
  async function taxContext(est, tenantId, { date = undefined, job = undefined } = {}) {
    return estimateTaxContext({ est, tenantId, tenantSlug: await slugFor(tenantId), date, now: d.now(), sfQuery: d.sfQuery, soqlEscapeString, loadTables: d.loadTaxTables, job });
  }
  /** What a response says about the tax (no tables, just the answer). */
  function publicTax(tax) {
    return { matched: tax.matched, zoneCode: tax.zoneCode, label: tax.label, rate: tax.rate, source: tax.source, reason: tax.reason, needed: !tax.matched && tax.reason !== "TEMPLATE" };
  }
  /** Totals the way every reader must see them: lines × the zone's category rates on the date. */
  // A shown estimate (Sent / Viewed / Approved / Invoiced — showsStoredTotals) reads its STORED
  // money, never a recomputation; `live` is an edit's recompute and the invoice issue.
  async function estimateTotals(est, lines, { tenantId = est?.Client__c, date, job, live = false } = {}) {
    const tax = await taxContext(est, tenantId, { date, job });
    const totals = computeTotals((lines || []).map(lineFromRecord), estimateFromRecord(est, tax));
    if (!live) withStoredTotals(totals, est);
    return Object.assign(totals, { tax: publicTax(tax) });
  }
  /** The zone a NEW job gets: the customer's city through the resolver. Fields empty when unresolved. */
  async function jobZoneFields(customer, tenantId) {
    const tables = await taxTablesFor(tenantId);
    const r = resolveTaxZoneIn(tables, customer?.City__c);
    if (!r.matched) return { fields: {}, matched: false, reason: r.reason, normalized: r.normalized };
    return { fields: { [TAX_ZONE_CODE_FIELD]: r.zone.code, [TAX_ZONE_LABEL_FIELD]: r.zone.label }, matched: true, zoneCode: r.zone.code, label: r.zone.label, via: r.via };
  }
  const zoneSummary = (z) => (z ? { matched: z.matched, zoneCode: z.zoneCode ?? null, label: z.label ?? null, needed: !z.matched, reason: z.reason ?? null } : null);
  const zoneWarnings = (z) => (z && !z.matched ? [`Tax zone needed: the customer's city${z.normalized ? ` ("${z.normalized}")` : ""} is not an Acumatica tax zone — pick the zone on the job before invoicing.`] : []);

  // --- totals: recompute + persist ----------------------------------------------
  // Tax_Rate__c / Tax_Jurisdiction__c are written with the totals — the zone's, as of today
  // (blank when the zone is not known). An Invoiced estimate is frozen: nothing is written.
  // A SHOWN estimate (Sent / Viewed / Approved with stored totals, 2026-10-16) keeps what the
  // customer saw unless `live`: only an EDIT (a line, the estimate, the zone, labor billing, a
  // create) passes live: true. Send, approve, Create Job and Recalculate never re-price it.
  async function recomputeAndStore(est, tenantId, { live = false } = {}) {
    const lines = await loadLines(est.Id, tenantId);
    if (est.Status__c === "Invoiced") return { totals: await estimateTotals(est, lines, { tenantId }), lines };
    const keep = !live && showsStoredTotals(est);
    const totals = await estimateTotals(est, lines, { tenantId, live: !keep });
    if (keep) return { totals, lines };
    const fields = { ...totals.fields };
    if (est.Is_Template__c !== true) {
      fields.Tax_Rate__c = totals.tax.matched ? totals.tax.rate : null;
      fields.Tax_Jurisdiction__c = totals.tax.matched ? totals.tax.label : null;
    }
    await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
    if ("Tax_Rate__c" in fields) Object.assign(est, { Tax_Rate__c: fields.Tax_Rate__c, Tax_Jurisdiction__c: fields.Tax_Jurisdiction__c });
    await markStale(CACHE.estimate, [est.Id], tenantId);
    return { totals, lines };
  }

  // --- customer select-or-create (§3.1a) ------------------------------------------
  // Returns { ok:true, customer, created, warnings, events } or { ok:false, response }.
  // `events` are activity rows deferred until the estimate/job exists, so the customer
  // step shows up on the job's feed (with the estimate/job ids) rather than floating.
  /** body.intake → the customer fields to write (only the answers given), with warnings for values the org lacks. */
  async function intakeUpdates(intake, warnings) {
    const out = {};
    if (!intake || typeof intake !== "object") return out;
    for (const [key, field] of Object.entries(INTAKE_FIELDS)) {
      const raw = intake[key];
      if (typeof raw !== "string" || !raw.trim()) continue;
      const v = raw.trim();
      if (field === "Description__c" || field === "Warranty_Notes__c") {
        out[field] = v.slice(0, 32000);
        continue;
      }
      const values = await picklistValues(CUSTOMER_SF_OBJECT, field);
      if (!values) {
        warnings.push(`${field} is not in this org yet — the intake answer "${v}" was not saved.`);
        continue;
      }
      const m = matchPicklist(v, values);
      if (m) out[field] = m;
      else warnings.push(`"${v}" is not a ${field} value — left blank.`);
    }
    return out;
  }

  async function resolveCustomer(body, ctx, cors) {
    const { tenantId } = ctx;
    const events = [];
    const spec = body?.customer;
    if (!spec || typeof spec !== "object") {
      return { ok: false, response: bad(cors, "CUSTOMER_REQUIRED", "Provide customer: { id } or customer: { new: {...} }.") };
    }
    const warnings = [];
    const intake = await intakeUpdates(body?.intake, warnings);
    // Two department tags, same value: Requested_Project_Types__c (the D-072 tag) and
    // Customer_Type__c (2026-09-19). Each is guarded by the org's describe — a field or a
    // picklist value the org lacks is a warning, never a failed create.
    const tags = [];
    for (const field of [PROJECT_TYPES_FIELD, CUSTOMER_TYPE_FIELD]) {
      const values = await picklistValues(CUSTOMER_SF_OBJECT, field);
      const tag = values ? matchPicklist(PROJECT_TYPE_TAG, values) : null;
      if (tag) tags.push({ field, tag });
      else warnings.push(`${field} has no "${PROJECT_TYPE_TAG}" value in this org — customer not tagged there. Add the field / picklist value in Setup.`);
    }
    const tag = tags.length ? PROJECT_TYPE_TAG : null;

    if (spec.id) {
      const customer = await loadCustomer(String(spec.id), tenantId);
      if (!customer) return { ok: false, response: notFound(cors) };
      const upd = { ...intake };
      // Newly Service (the intake alert cares): the department tag was not there before this call.
      const taggedNow = !String(customer[CUSTOMER_TYPE_FIELD] ?? "").split(";").map((x) => x.trim()).includes(PROJECT_TYPE_TAG);
      let unarchived = false;
      for (const t of tags) {
        const merged = unionProjectTypes(customer[t.field], t.tag);
        if (merged) upd[t.field] = merged;
      }
      // An archived customer (2026-10-02, the HCP import's address book) who calls in and gets
      // an estimate / job / Service entry is active again: the flag comes off in the same write.
      // Guarded by describe (an org without the field skips it) and read first (no write on
      // the thousands that are not archived).
      if (await fieldExists(CUSTOMER_SF_OBJECT, ARCHIVED_FIELD)) {
        try {
          const rows = await d.sfQuery(`SELECT ${ARCHIVED_FIELD} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(customer.Id)}' LIMIT 1`);
          if (rows?.[0]?.[ARCHIVED_FIELD] === true) {
            upd[ARCHIVED_FIELD] = false;
            unarchived = true;
          }
        } catch (e) {
          console.error("archived read failed:", e?.message || e); // bookkeeping only
        }
      }
      // What the intake answers were, for the feed's "Intake updated" line (D-084): read only
      // when the popup sent answers, and only those fields (each one passed the describe above).
      let intakeBefore = null;
      if (Object.keys(intake).length) {
        try {
          const rows = await d.sfQuery(`SELECT Id, ${Object.keys(intake).join(", ")} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(customer.Id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`);
          intakeBefore = rows?.[0] ?? null;
        } catch (e) {
          console.error("intake before-read failed:", e?.message || e); // no comment rather than a wrong one
        }
      }
      if (Object.keys(upd).length) {
        try {
          await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, upd);
          Object.assign(customer, upd);
          if (intakeBefore) await customerFeedLines(ctx, customer.Id, intakeBefore, intake);
          await markStale(CACHE.customer, [customer.Id], tenantId);
          const [field, to] = Object.entries(upd)[0]; // one feed row per pick; `fields` carries both when both changed
          events.push({ event: EVENTS.CUSTOMER_TAGGED, recordType: "customer", recordSfId: customer.Id, details: { field, to, fields: upd, unarchived: upd[ARCHIVED_FIELD] === false || undefined } });
        } catch (e) {
          // Tagging is bookkeeping; the estimate/job still gets created.
          warnings.push(`Could not tag the customer with ${PROJECT_TYPE_TAG}: ${e?.sfBody || e?.message || e}`);
          unarchived = false;
        }
      }
      return { ok: true, customer, created: false, warnings, events, unarchived, taggedNow };
    }

    if (spec.new) {
      const norm = normalizeNewCustomer(spec.new);
      if (!norm.ok) {
        return { ok: false, response: bad(cors, "CUSTOMER_INVALID", "New customer needs a name (a company name for a company) and an email or phone.", { missing: norm.missing }) };
      }
      const c = norm.value;
      // Lead Source (2026-10-16, Harmon): the org's own picklist, matched case-insensitively
      // and written in the org's spelling. An unknown value is a 400 that lists nothing (the
      // picklist is ~240 values; the portal reads them from GET /sf/meta/customer/picklists).
      // Checked before the duplicate guard so a bad value never reaches a create.
      let leadSource = null;
      const rawLead = typeof spec.new.leadSource === "string" ? spec.new.leadSource.trim() : "";
      if (rawLead) {
        const values = await picklistValues(CUSTOMER_SF_OBJECT, LEAD_SOURCE_FIELD);
        if (!values) warnings.push(`${LEAD_SOURCE_FIELD} could not be read from the org — the lead source was not saved.`);
        else {
          leadSource = matchPicklist(rawLead, values);
          if (!leadSource) return { ok: false, response: bad(cors, "LEAD_SOURCE_INVALID", `"${rawLead.slice(0, 80)}" is not a Lead Source value.`) };
        }
      }
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
      for (const t of tags) fields[t.field] = t.tag;
      Object.assign(fields, intake);
      if (leadSource) fields[LEAD_SOURCE_FIELD] = leadSource;
      let created;
      try {
        created = await d.sfCreateRecord(CUSTOMER_SF_OBJECT, fields);
      } catch (e) {
        return { ok: false, response: sfError(cors, e, "customer create") };
      }
      const customer = { Id: created.id, ...fields };
      await customerFeedLines(ctx, customer.Id, {}, intake);
      events.push({ event: EVENTS.CUSTOMER_CREATED, recordType: "customer", recordSfId: customer.Id, details: { name: fields.Name, tagged: tag ? [tag] : [], viaPopup: true, intake: Object.keys(intake).length ? Object.keys(intake) : undefined } });
      return { ok: true, customer, created: true, warnings, events, unarchived: false, taggedNow: true };
    }
    return { ok: false, response: bad(cors, "CUSTOMER_REQUIRED", "customer must carry id or new.") };
  }

  /**
   * The customer feed's own lines (D-084, lib/intake-comment.js): "Intake updated …" for the
   * answers this write changed, "Assigned to …" for a new assignee. After the Salesforce write,
   * best-effort — never a reason to fail the popup.
   */
  async function customerFeedLines(ctx, customerId, before, written) {
    await commentOnCustomerWrite({
      getSupabaseClient: d.getSupabaseClient,
      loadUserName: async (id) => {
        const rows = await d.sfQuery(`SELECT Id, First_Name__c, Last_Name__c FROM Sundial_User__c WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(ctx.tenantId)}' LIMIT 1`);
        return rows?.[0] ? userDisplayName(rows[0]) : null;
      },
      tenantId: ctx.tenantId,
      customerId,
      before,
      written,
      actor: { ...(ctx.actor || {}), profileId: ctx.profileId ?? null },
      at: d.now(),
    });
  }

  /**
   * The Service intake alerts (Harmon, 2026-10-02), after a popup's customer landed:
   * someone was just put in Assigned To → that person; a customer that is new to Service
   * (created, un-archived, or tagged Service for the first time) with nobody assigned → the
   * Service managers. Best-effort, after every write.
   */
  async function intakeAlerts(ctx, r, { assignedTo = null, assignedBefore = null } = {}) {
    const customer = r?.customer;
    if (!customer?.Id) return;
    const reason = r.created ? "created" : r.unarchived ? "unarchived" : r.taggedNow ? "created" : null;
    if (assignedTo && assignedTo !== assignedBefore) {
      await alertAssigned({ notifier: d.notifier, tenantId: ctx.tenantId, customer, assignedToSfId: assignedTo, actorUserSfId: ctx.userId, actorName: ctx.actor?.name ?? null, now: d.now() });
      return;
    }
    if (!reason || assignedTo || assignedBefore) return;
    await alertUnassignedCustomer({ notifier: d.notifier, sfQuery: d.sfQuery, tenantId: ctx.tenantId, customer: { ...customer, Assigned_To__c: null }, reason, actorUserSfId: ctx.userId, now: d.now() });
  }

  async function flushEvents(ctx, events, refs) {
    for (const e of events || []) await act(ctx, { ...e, ...refs });
  }

  function snapshotFields(customer) {
    return {
      Customer_Name_at_Creation__c: customerDisplayName(customer), // D-081: the company name for a company
      Address_at_Creation__c: [customer.Street__c, customer.City__c, customer.State__c, customer.Postal_Code__c].filter(Boolean).join(", ") || null,
      Primary_Phone_at_Creation__c: customer.Primary_Phone__c ?? null,
      Primary_Email_at_Creation__c: customer.Primary_Email__c ?? null,
    };
  }

  // --- estimate creation core (shared by createEstimate / createJob) ---------------
  async function createEstimateRecord({ customer, body, tenantId, userId, billTo = null }) {
    const { fields: extra, rejected } = translate(withoutBillToKeys(body?.estimate || {}), ESTIMATE_PATCHABLE);
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
      // Tax (D-083): no default here — recomputeAndStore writes the zone's rate and label
      // right after the lines land (the customer's city until the estimate has a job).
      // A Service Club member's estimate starts with the plan's discount (D-073.7) unless
      // the caller set a discount of its own; the office can change it like any discount.
      if (extra.Discount_Value__c === undefined) {
        const disc = await club.discountForCustomer(customer.Id, tenantId);
        if (disc) Object.assign(fields, disc);
      }
    }
    if (fields.Sold_By__c === undefined && body?.soldBySelf === true && userId) fields.Sold_By__c = userId;
    // Who pays (D-081 amendment 2): decided by resolveBillTo BEFORE anything was created.
    if (!isTemplate && billTo?.fields) Object.assign(fields, billTo.fields);
    for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
    const created = await d.sfCreateRecord(ESTIMATE_SF_OBJECT, fields);
    return { id: created.id, fields, rejected };
  }

  async function addLinesToEstimate(estimateId, tenantId, lines) {
    const createdIds = [];
    const problems = [];
    const descriptionMax = await lineDescriptionMax();
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
        fields = lineFromItem(item, { ...spec, sortOrder: spec.sortOrder ?? sort }, { estimateId, tenantId, descriptionMax });
      } else {
        const r = adHocLine({ ...spec, sortOrder: spec?.sortOrder ?? sort }, { estimateId, tenantId, descriptionMax });
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
    const descriptionMax = await lineDescriptionMax();
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
            taxCategory: l.Tax_Category__c, // the template's own choice wins over the item's default
          }, { estimateId, tenantId, descriptionMax });
        }
      }
      const c = await d.sfCreateRecord(LINE_SF_OBJECT, fields);
      ids.push(c.id);
    }
    return { ids, count: ids.length };
  }

  /**
   * The Bill To fields for a new job (D-081, lib/bill-to.js). Run BEFORE the customer /
   * estimate are created so a 400 never leaves half a job behind. Returns resolveBillTo's
   * answer; `billToName` in the body is ignored (the name is derived) and logged once.
   */
  async function jobBillTo(jobBody, tenantId) {
    if (jobBody && Object.prototype.hasOwnProperty.call(jobBody, "billToName")) {
      console.warn(JSON.stringify({ ignoredField: "billToName", reason: "Bill_To_Name__c is derived from Bill_To_Customer__c (D-081)" }));
    }
    return resolveBillTo({
      type: jobBody?.billToType === undefined ? undefined : strOrNull(jobBody.billToType) ?? "",
      customerId: jobBody?.billToCustomerId,
      before: null,
      loadCustomer: billToCustomerLoader({ sfQuery: d.sfQuery, soqlEscapeString, tenantId }),
    });
  }
  const billToRefused = (cors, r) => jsonResponse(r.status, cors, { error: r.code.toLowerCase(), code: r.code, field: "Bill_To_Customer__c", message: r.message });

  async function createJobRecord({ customer, estimateId, body, tenantId, billTo = null }) {
    const { fields: extra, rejected } = translate(body?.job || {}, JOB_CREATE_FIELDS);
    // The Bill To trio comes ONLY from resolveBillTo (callers that never send one — the
    // Service Club's public pages — get the default: the job's own customer pays).
    delete extra.Bill_To_Type__c;
    delete extra.Bill_To_Customer__c;
    const resolved = billTo ?? (await jobBillTo(body?.job, tenantId));
    if (!resolved.ok) throw Object.assign(new Error(resolved.message), { billTo: resolved });
    Object.assign(extra, resolved.fields);
    // The tax zone (D-083), from the customer's city — never a guess: unmatched = blank.
    const zone = await jobZoneFields(customer, tenantId);
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
      ...zone.fields,
    };
    for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
    const created = await d.sfCreateRecord(JOB_SF_OBJECT, fields);
    return { id: created.id, fields, rejected, taxZone: zone };
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
      let resolved = null;
      // Bill To first (D-081 amendment 2): a missing / unknown payer refuses before the
      // customer exists, as on New Job.
      const billTo = body?.isTemplate === true ? null : await estimateBillTo(body?.estimate, null, tenantId);
      if (billTo && !billTo.ok) return billToRefused(cors, billTo);
      if (body?.isTemplate !== true) {
        const r = await resolveCustomer(body, ctx, cors);
        if (!r.ok) return r.response;
        ({ customer, warnings } = r);
        customerCreated = r.created;
        customerEvents = r.events;
        resolved = r;
      }
      let est;
      try {
        est = await createEstimateRecord({ customer, body, tenantId, userId, billTo });
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
      const { totals } = await recomputeAndStore(full, tenantId, { live: true });
      await flushEvents(ctx, customerEvents, { estimateSfId: est.id });
      if (resolved) await intakeAlerts(ctx, resolved);
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
      const totals = await estimateTotals(est, lines, { tenantId });
      // What a line COSTS is Admin / Executive only (lib/cost-gate.js); the sell price stays.
      const seesCost = ctx.can ? ctx.can(COSTING_READ) === true : false;
      const shown = seesCost ? lines : lines.map((l) => stripCost("serviceline", l));
      return jsonResponse(200, cors, { estimate: est, lines: shown, totals, taxZone: totals.tax, ...(await estimateReadExtras(est, tenantId)) });
    },

    async patchEstimate({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      // The markup is Admin / Executive (2026-10-16): a blank markupType / markupValue from anyone
      // else is not sent, a value is 403. Only blank markup keys = nothing to do, not a 400.
      const mg = markupGate(ctx, body);
      if (!mg.ok) return costForbidden(cors, mg);
      if (mg.dropped.length && !Object.keys(mg.fields).length) return jsonResponse(200, cors, { success: true, id: est.Id, unchanged: true, ignoredFields: mg.dropped });
      body = mg.fields;
      const { fields, rejected } = translate(withoutBillToKeys(body), ESTIMATE_PATCHABLE);
      // Who pays (D-081 amendment 2): the same resolveBillTo as the job; billToName is derived, never accepted.
      if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "billToName")) rejected.push("billToName");
      const billTo = await estimateBillTo(body, est, tenantId);
      if (!billTo.ok) return billToRefused(cors, billTo);
      Object.assign(fields, billTo.fields);
      if (!Object.keys(fields).length) return bad(cors, "NO_FIELDS", "Nothing to update.", { rejectedFields: rejected });
      try {
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, fields);
      } catch (e) {
        return sfError(cors, e, "estimate update");
      }
      const { totals } = await recomputeAndStore({ ...est, ...fields }, tenantId, { live: true });
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
      const { totals, lines: after } = await recomputeAndStore(est, tenantId, { live: true });
      await markStale(CACHE.line, result.createdIds, tenantId);
      for (const id of result.createdIds) {
        const l = after.find((x) => x.Id === id) || {};
        await act(ctx, { event: EVENTS.LINE_ADDED, recordType: "serviceline", recordSfId: id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { description: l.Description__c ?? null, kind: l.Kind__c ?? null, quantity: l.Quantity__c ?? null, unitPrice: l.Unit_Price__c ?? null, priceBookItemId: l.Price_Book_Item__c ?? null, source: l.Source__c ?? null, total: totals.total } });
      }
      return jsonResponse(201, cors, { success: true, ids: result.createdIds, problems: result.problems, totals: totals.fields });
    },

    /**
     * POST /service/tech/calls/{id}/estimate-lines — a tech adds work found on site
     * (D-072 amendment 7). Every line lands as Proposed, Source "Field", tagged with
     * the call that found it; the office reviews and the customer approves as usual.
     * The tech may only add to the estimate of a job they have a call on (tenant scope
     * may act for any tech); anything else is a 404, never a hint.
     */
    async techAddLines({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      if (!SF_ID_RE.test(params[0] || "")) return notFound(cors);
      const calls = await d.sfQuery(
        `SELECT Id, Tech__c, Status__c, Sundial_Service_Job__c FROM ${CALL_SF_OBJECT} WHERE Id = '${soqlEscapeString(params[0])}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
      );
      const call = calls?.[0];
      if (!call || !(ctx.scope === "tenant" || (ctx.userId && call.Tech__c === ctx.userId))) return notFound(cors);
      if (call.Status__c === "Cancelled") return jsonResponse(409, cors, { error: "cancelled", code: "CALL_CANCELLED", message: "This call was cancelled by the office." });
      const job = call.Sundial_Service_Job__c ? await loadJob(call.Sundial_Service_Job__c, tenantId) : null;
      if (!job?.Estimate__c) return jsonResponse(409, cors, { error: "no_estimate", code: "NO_ESTIMATE", message: "This job has no estimate yet — ask the office to create one." });
      const est = await loadEstimate(job.Estimate__c, tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED", message: "This job is already invoiced; the office can add a change order." });
      const specs = (Array.isArray(body?.lines) ? body.lines : [body]).map((spec) => ({
        ...(spec && typeof spec === "object" ? spec : {}),
        stage: "Proposed",
        source: "Field",
        addedByServiceCallId: call.Id,
        sortOrder: undefined, // appended after what is there
      }));
      const existing = await loadLines(est.Id, tenantId);
      const offset = existing.reduce((m, l) => Math.max(m, Number(l.Sort_Order__c) || 0), 0);
      let result;
      try {
        result = await addLinesToEstimate(est.Id, tenantId, specs.map((sp, i) => ({ ...sp, sortOrder: offset + (i + 1) * 10 })));
      } catch (e) {
        return sfError(cors, e, "field line create");
      }
      if (!result.createdIds.length) return bad(cors, "LINE_INVALID", "No line could be added.", { problems: result.problems });
      const { totals, lines: after } = await recomputeAndStore(est, tenantId, { live: true });
      await markStale(CACHE.line, result.createdIds, tenantId);
      const created = [];
      for (const id of result.createdIds) {
        const l = after.find((x) => x.Id === id) || {};
        created.push({ id, description: l.Description__c ?? null, kind: l.Kind__c ?? null, quantity: l.Quantity__c ?? null, unitPrice: l.Unit_Price__c ?? null, lineTotal: l.Line_Total__c ?? null, stage: l.Stage__c ?? null, addedByThisCall: true });
        await act(ctx, { event: EVENTS.LINE_ADDED, recordType: "serviceline", recordSfId: id, estimateSfId: est.Id, jobSfId: job.Id, details: { description: l.Description__c ?? null, kind: l.Kind__c ?? null, quantity: l.Quantity__c ?? null, unitPrice: l.Unit_Price__c ?? null, priceBookItemId: l.Price_Book_Item__c ?? null, source: "Field", callId: call.Id, total: totals.total, via: "tech" } });
      }
      return jsonResponse(201, cors, { success: true, estimateId: est.Id, lines: created, problems: result.problems, totals: totals.fields });
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
      const { fields, rejected, problems } = linePatchFields(plain, { descriptionMax: await lineDescriptionMax() });
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
      withDerivedTaxable(fields, line); // Taxable__c is derived from the category (D-083), never typed
      const MONEY_FIELDS = ["Unit_Price__c", "Quantity__c", "Kind__c", "Taxable__c", "Tax_Category__c"];
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
      const { totals } = await recomputeAndStore(est, tenantId, { live: true });
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
      const { totals } = await recomputeAndStore(est, tenantId, { live: true });
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
      const { totals } = await recomputeAndStore(est, tenantId, { live: true });
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
      const via = viaFrom(body, { allowManual: true });
      // Who it goes to (lib/send-to.js, D-072 amendment 12): the box, else the payer, else the
      // customer — decided BEFORE the version is recorded, so a send that cannot reach anyone
      // is a 400 and changes nothing.
      const recs = await recipientRecords({ payerId: estimatePayerId(est), customerId: est.Sundial_Customer__c, tenantId });
      let recipients = { email: null, phone: null };
      if (via !== "Manual") {
        const r = resolveRecipients({ via, to: body?.to, toPhone: body?.toPhone, ...recs, snapshot: estimateSnapshot(est) });
        if (!r.ok) return jsonResponse(r.status, cors, { error: "bad_request", code: r.code, message: r.message, ...(r.missing ? { missing: r.missing } : {}), ...(r.invalid ? { invalid: r.invalid } : {}) });
        recipients = { email: r.email, phone: r.phone };
      }
      const { totals, lines } = await recomputeAndStore(est, tenantId);
      const now = d.now();
      const version = (Number(est.Version__c) || 0) + 1;
      const validDays = Number(body?.validDays) > 0 ? Number(body.validDays) : DEFAULTS.validDays;
      const validUntil = new Date(now.getTime() + validDays * 86400000);
      const tokenExpires = new Date(now.getTime() + Math.max(validDays, DEFAULTS.publicTokenDays) * 86400000);
      const token = est.Public_Token__c || d.randomToken();
      const url = publicEstimateUrl(token, publicBaseFor(ctx));
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
        const model = buildEstimateModel({ estimate: docEstimate, lines, totals, brand, payer: recs.payer, options: { mode: "customer", acceptUrl: url || undefined } });
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

      // Delivery: email (SES, lib/email.js) and / or a text (lib/sms-send.js, the job's
      // conversation — D-072 amendment 12). `Both` sends both; one failing is reported in
      // deliveryDetail and never undoes the other. The version is recorded either way.
      let delivery = "recorded";
      const detail = [];
      let recipient = null;
      let textedTo = null;
      if (needsEmail(via)) {
        if (!url) detail.push(noPublicUrlDetail(ctx));
        else if (!d.isEmailConfigured()) detail.push("EMAIL_FROM is not set on this Lambda (SES not wired).");
        else {
          const email = recipients.email; // resolved above; a send with no email never got this far
          // The card line is left out once a card is on file for the estimate's job (amendment 11).
          let cardOnFile = false;
          if (est.Service_Job__c) {
            const jobRows = await d.sfQuery(`SELECT Id, Customer_Card_on_File__c FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(est.Service_Job__c)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`).catch(() => []);
            cardOnFile = jobRows?.[0]?.Customer_Card_on_File__c === true;
          }
          const msg = buildEstimateEmail({ est, total: totals.total, url, brandName: brand.companyName, validUntil: validUntilOut, cardOnFile });
          const attachments = pdfBytes
            ? [{ fileName: `${est.Name || "estimate"}-v${version}.pdf`, contentType: "application/pdf", content: pdfBytes }]
            : [];
          const sent = await d.sendEmail({ to: email, subject: msg.subject, html: msg.html, text: msg.text, attachments });
          if (sent.ok) {
            delivery = "email";
            recipient = email;
          } else detail.push(`Email failed: ${sent.error}`);
        }
      }
      if (needsPhone(via)) {
        if (!url) {
          if (!needsEmail(via)) detail.push(noPublicUrlDetail(ctx));
        } else if (!d.sms) detail.push("Texting is not wired on this Lambda.");
        else {
          // The job's conversation when there is a job; before one, the text is kept against
          // the customer (it joins no thread until a job exists).
          const threadJob = { Id: est.Service_Job__c ?? null, Sundial_Customer__c: est.Sundial_Customer__c ?? null, Primary_Phone_at_Creation__c: est.Primary_Phone_at_Creation__c ?? null };
          const r = await d.sms.sendText({ tenantId, tenantSlug: ctx.tenantSlug, job: threadJob, to: recipients.phone, body: buildEstimateText({ est, total: totals.total, url, brandName: brand.companyName }), sentBy: { id: ctx.userId ?? null, name: ctx.actor?.name ?? null } });
          if (r.ok) {
            textedTo = r.to ?? recipients.phone;
            delivery = delivery === "email" ? "both" : "sms";
          } else detail.push(r.code === "NO_PHONE" ? "There is no mobile number to text." : `Text failed: ${r.error || r.code}`);
        }
      }
      if (pdfError) detail.push("The PDF could not be generated for this version (the link still works).");
      const deliveryDetail = detail.filter(Boolean).join(" ") || null;
      const used = { email: recipient, phone: textedTo };

      await act(ctx, { event: EVENTS.ESTIMATE_SENT, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { version, via, delivery, recipient, textedTo, recipients: used, deliveryDetail, total: totals.total, validUntil: validUntilOut, lineCount: entry.lines.length, pdfKey } });
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
        delivery, // "email" | "sms" | "both" (what went out) | "recorded" (version bumped, nothing went out — see deliveryDetail)
        recipient,
        textedTo,
        recipients: used, // what was actually used: { email, phone } (null = not sent that way)
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
      // Who pays (D-081 amendment 2): the request's Bill To when it names one, else the
      // estimate's — copied at creation; after that the two are independent.
      const namesBillTo = body?.job && ["billToType", "billToCustomerId"].some((k) => Object.prototype.hasOwnProperty.call(body.job, k));
      const inherited = est.Bill_To_Type__c ? { billToType: est.Bill_To_Type__c, billToCustomerId: est.Bill_To_Customer__c ?? null } : {};
      const billTo = await jobBillTo(namesBillTo ? body.job : inherited, tenantId);
      if (!billTo.ok) return billToRefused(cors, billTo);
      let job;
      try {
        job = await createJobRecord({ customer, estimateId: est.Id, body: { job: { intakeChannel: "Estimate Conversion", ...(body?.job || {}) } }, tenantId, billTo });
        await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Service_Job__c: job.id });
      } catch (e) {
        return sfError(cors, e, "job create");
      }
      await markStale(CACHE.estimate, [est.Id], tenantId);
      // The estimate is now taxed by the job's zone (D-083): its rate and label follow.
      let totalsAfter = null;
      try {
        ({ totals: totalsAfter } = await recomputeAndStore({ ...est, Service_Job__c: job.id }, tenantId));
      } catch (e) {
        console.error("create job: estimate tax recompute failed:", e?.sfBody || e?.message || e);
      }
      await linkEstimateActivityToJob(d.getSupabaseClient, { tenantId, estimateSfId: est.Id, jobSfId: job.id });
      await act(ctx, { event: EVENTS.JOB_CREATED, recordType: "job", recordSfId: job.id, jobSfId: job.id, estimateSfId: est.Id, details: { fromEstimate: true, estimateNumber: est.Name ?? null, customerId: customer.Id } });
      // A deposit / card that arrived before the job existed (Stripe ledger) lands on it now.
      let stripeDeferred = { applied: 0 };
      try {
        stripeDeferred = await stripeH.applyDeferred({ ctx, estimateId: est.Id, jobId: job.id });
      } catch (e) {
        console.error("create job: deferred Stripe apply failed:", e?.message || e);
      }
      return jsonResponse(201, cors, { success: true, jobId: job.id, estimateId: est.Id, rejectedFields: job.rejected, stripeApplied: stripeDeferred.applied, taxZone: zoneSummary(job.taxZone), totals: totalsAfter?.fields ?? null, warnings: zoneWarnings(job.taxZone) });
    },

    // The Service module's New Customer and its "Add to Service" button (D-075,
    // docs/service-customer-layout.md). The same select-or-create the popups use —
    // duplicate guard, the Service tag on both department fields — then the Service
    // pipeline is opened: Service_Stage__c = New (never overwriting a stage already set),
    // plus whatever the office typed about the request. Every field is describe-guarded:
    // an org without the D-075 fields still gets its customer, with a warning.
    async createServiceCustomer({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const r = await resolveCustomer(body, ctx, cors);
      if (!r.ok) return r.response;
      const { customer, created, warnings, events } = r;
      const upd = {};
      const stageValues = await picklistValues(CUSTOMER_SF_OBJECT, SERVICE_STAGE_FIELD);
      const newStage = stageValues ? matchPicklist(SERVICE_STAGE_NEW, stageValues) : null;
      if (!stageValues) warnings.push(`${SERVICE_STAGE_FIELD} is not in this org yet — deploy salesforce/service-customer-2026-09-23/.`);
      else if (!newStage) warnings.push(`${SERVICE_STAGE_FIELD} has no "${SERVICE_STAGE_NEW}" value.`);
      else {
        // The candidate select cannot name the field (an org without it would break every
        // popup), so an existing customer's current stage is read here, guarded.
        let currentStage = null;
        if (!created) {
          const rows = await d.sfQuery(`SELECT ${SERVICE_STAGE_FIELD}, Assigned_To__c, Description__c, ${FOLLOW_UP_DATE_FIELD} FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(customer.Id)}' LIMIT 1`);
          currentStage = rows?.[0]?.[SERVICE_STAGE_FIELD] ?? null;
          customer[SERVICE_STAGE_FIELD] = currentStage;
          customer.Assigned_To__c = rows?.[0]?.Assigned_To__c ?? null;
          customer.Description__c = rows?.[0]?.Description__c ?? customer.Description__c ?? null;
          customer[FOLLOW_UP_DATE_FIELD] = rows?.[0]?.[FOLLOW_UP_DATE_FIELD] ?? null;
        }
        if (created || !currentStage) upd[SERVICE_STAGE_FIELD] = newStage;
      }
      const req = body?.request && typeof body.request === "object" ? body.request : {};
      if (typeof req.requestType === "string" && req.requestType.trim()) {
        const values = await picklistValues(CUSTOMER_SF_OBJECT, SERVICE_REQUEST_TYPE_FIELD);
        const m = values ? matchPicklist(req.requestType.trim(), values) : null;
        if (m) upd[SERVICE_REQUEST_TYPE_FIELD] = m;
        else warnings.push(`Request type "${req.requestType}" is not a ${SERVICE_REQUEST_TYPE_FIELD} value — left blank.`);
      }
      if (typeof req.description === "string" && req.description.trim() && !body?.intake?.description) upd.Description__c = req.description.trim().slice(0, 32000);
      if (typeof req.assignedTo === "string" && SF_ID_RE.test(req.assignedTo)) {
        upd.Assigned_To__c = req.assignedTo;
        upd.Assigned_Date__c = d.now().toISOString().slice(0, 10);
      }
      if (typeof req.nextFollowUp === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.nextFollowUp)) upd.Next_Follow_Up_Date__c = req.nextFollowUp;
      // A new follow-up date ticks Follow-up needed in the same write (lib/follow-up.js).
      applyFollowUpFlag(created ? null : customer, upd);
      if (typeof req.leadSource === "string" && req.leadSource.trim()) {
        const values = await picklistValues(CUSTOMER_SF_OBJECT, "Lead_Source__c");
        const m = values ? matchPicklist(req.leadSource.trim(), values) : null;
        if (m) upd.Lead_Source__c = m;
        else warnings.push(`Lead source "${req.leadSource}" is not a Lead_Source__c value — left blank.`);
      }
      // The feed's lines for THIS write (the request's description, the assignee) — the intake
      // answers were already commented by resolveCustomer. What they were before, for the diff.
      const feedBefore = created ? {} : { Assigned_To__c: customer.Assigned_To__c ?? null, Description__c: customer.Description__c ?? null };
      if (Object.keys(upd).length) {
        try {
          await d.sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, upd);
          await markStale(CACHE.customer, [customer.Id], tenantId);
          await customerFeedLines(ctx, customer.Id, feedBefore, upd);
          events.push({ event: EVENTS.CUSTOMER_TAGGED, recordType: "customer", recordSfId: customer.Id, details: { field: SERVICE_STAGE_FIELD, to: upd[SERVICE_STAGE_FIELD] ?? null, fields: upd, service: true } });
        } catch (e) {
          warnings.push(`Customer saved, but the Service fields were not: ${e?.sfBody || e?.message || e}`);
        }
      }
      await flushEvents(ctx, events, {});
      await intakeAlerts(ctx, r, { assignedTo: upd.Assigned_To__c ?? null, assignedBefore: customer.Assigned_To__c ?? null });
      return jsonResponse(created ? 201 : 200, cors, {
        success: true,
        customerId: customer.Id,
        customerCreated: created,
        serviceStage: upd[SERVICE_STAGE_FIELD] ?? customer[SERVICE_STAGE_FIELD] ?? null,
        warnings,
      });
    },

    async createJob({ ctx, body }) {
      const { tenantId, userId, cors } = ctx;
      // Path A: convert an existing estimate. Path B: quick-create estimate + job.
      if (body?.estimateId) {
        return H.createJobFromEstimate({ ctx, params: [String(body.estimateId)], body });
      }
      // Bill To first (D-081): a missing / unknown payer must refuse before the customer
      // and estimate exist, not after.
      const billTo = await jobBillTo(body?.job, tenantId);
      if (!billTo.ok) return billToRefused(cors, billTo);
      const r = await resolveCustomer(body, ctx, cors);
      if (!r.ok) return r.response;
      const { customer, created: customerCreated, warnings, events: customerEvents } = r;
      let est;
      try {
        // Created together = the same payer (D-081 amendment 2): the estimate takes the job's Bill To.
        est = await createEstimateRecord({ customer, body, tenantId, userId, billTo });
      } catch (e) {
        const resp = sfError(cors, e, "estimate create");
        if (customerCreated) resp.body = JSON.stringify({ ...JSON.parse(resp.body), customerCreated: true, customerId: customer.Id });
        return resp;
      }
      let job;
      try {
        job = await createJobRecord({ customer, estimateId: est.id, body, tenantId, billTo });
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
      const { totals } = await recomputeAndStore(full, tenantId, { live: true });
      await flushEvents(ctx, customerEvents, { estimateSfId: est.id, jobSfId: job.id });
      await intakeAlerts(ctx, r);
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
        taxZone: zoneSummary(job.taxZone),
        warnings: [...warnings, ...zoneWarnings(job.taxZone)],
      });
    },

    // --- price book ------------------------------------------------------------------
    // What an item COSTS (laborCost / materialCost) is Admin / Executive only
    // (lib/cost-gate.js, 2026-10-16): from anyone else a BLANK cost key is "not sent" and
    // dropped — today's portal sends both on every save — and a non-blank one is a 403.
    async createItem({ ctx, body }) {
      const { tenantId, cors } = ctx;
      const gate = itemCostGate(ctx, body);
      if (!gate.ok) return costForbidden(cors, gate);
      const { fields, rejected, problems } = itemFieldsFromBody(gate.fields, { requireAll: true });
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
        created = await d.sfCreateRecord(ITEM_SF_OBJECT, withDerivedTaxable({ ...fields, Version__c: 1, Is_Active__c: true, Client__c: tenantId }));
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
      const gate = itemCostGate(ctx, body);
      if (!gate.ok) return costForbidden(cors, gate);
      const { fields, rejected, problems } = itemFieldsFromBody(gate.fields);
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
      withDerivedTaxable(fields, item); // Taxable__c follows the item's category (D-083)
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
      const gate = itemCostGate(ctx, body);
      if (!gate.ok) return costForbidden(cors, gate);
      const { fields: edits, rejected, problems } = itemFieldsFromBody(gate.fields);
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

    // --- sales tax zones (D-083) ------------------------------------------------------
    /**
     * GET /service/tax-zones[?city=] — the office's picker: every RETAIL zone (cities and the
     * county-only zones) with today's rate. With ?city= it also says what the resolver
     * would pick for that city (or that it would not).
     */
    async listTaxZones({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const tables = await taxTablesFor(tenantId);
      if (!tables || !tables.zones.size) return jsonResponse(200, cors, { zones: [], configured: false, message: "The tax tables are not loaded for this account yet." });
      const today = d.now();
      const zones = [...tables.zones.values()]
        .filter((z) => z.isRetail)
        .map((z) => ({ code: z.code, label: z.label, county: z.county, cityKey: z.cityKey, countyOnly: !z.cityKey, rate: headlineRate({ zone: z, tables, date: today }) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      let resolved = undefined;
      if (typeof query?.city === "string") {
        const r = resolveTaxZoneIn(tables, query.city);
        resolved = r.matched ? { matched: true, code: r.zone.code, label: r.zone.label, via: r.via } : { matched: false, reason: r.reason, normalized: r.normalized };
      }
      return jsonResponse(200, cors, { zones, configured: true, ...(resolved ? { resolved } : {}) });
    },

    /**
     * POST /service/jobs/{id}/tax-zone { zoneCode } — the office sets or corrects the job's
     * zone (the "Tax zone needed" fix). The code must be one of the tenant's RETAIL zones; the
     * label is derived, never typed. null clears it. The estimate is re-taxed unless invoiced.
     */
    async setJobTaxZone({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      if (!SF_ID_RE.test(params[0] || "")) return notFound(cors);
      const rows = await d.sfQuery(
        `SELECT Id, Name, Estimate__c, ${TAX_ZONE_CODE_FIELD}, ${TAX_ZONE_LABEL_FIELD} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(params[0])}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
      );
      const job = rows?.[0];
      if (!job) return notFound(cors);
      let fields;
      if (body?.zoneCode === null) {
        fields = { [TAX_ZONE_CODE_FIELD]: null, [TAX_ZONE_LABEL_FIELD]: null };
      } else {
        const code = String(body?.zoneCode ?? "").trim().toUpperCase();
        if (!code) return bad(cors, "ZONE_CODE_REQUIRED", "Pick a tax zone (zoneCode).");
        const tables = await taxTablesFor(tenantId);
        const zone = tables?.zones.get(code);
        if (!zone || !zone.isRetail) return bad(cors, "TAX_ZONE_UNKNOWN", `${code} is not one of this account's retail tax zones.`);
        fields = { [TAX_ZONE_CODE_FIELD]: zone.code, [TAX_ZONE_LABEL_FIELD]: zone.label };
      }
      try {
        await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, fields);
      } catch (e) {
        return sfError(cors, e, "job tax zone");
      }
      await markStale(CACHE.job, [job.Id], tenantId);
      let totals = null;
      if (job.Estimate__c) {
        const est = await loadEstimate(job.Estimate__c, tenantId);
        if (est && est.Status__c !== "Invoiced") ({ totals } = await recomputeAndStore(est, tenantId, { live: true }));
      }
      await act(ctx, { event: EVENTS.JOB_UPDATED, recordType: "job", recordSfId: job.Id, jobSfId: job.Id, estimateSfId: job.Estimate__c ?? null, details: { fields: diffFields(job, fields), via: "tax-zone" } });
      return jsonResponse(200, cors, { success: true, jobId: job.Id, taxZone: { zoneCode: fields[TAX_ZONE_CODE_FIELD], label: fields[TAX_ZONE_LABEL_FIELD], needed: !fields[TAX_ZONE_CODE_FIELD] }, totals: totals?.fields ?? null });
    },

    // --- preview (read-only; the same renderer the hosted page / PDF / email use) ------
    async previewEstimate({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      const lines = await loadLines(est.Id, tenantId);
      const totals = await estimateTotals(est, lines, { tenantId });
      // The printed jurisdiction / rate are the zone's today — unless the estimate shows its stored totals.
      if (!showsStoredTotals(est) && est.Status__c !== "Invoiced" && est.Is_Template__c !== true) Object.assign(est, { Tax_Jurisdiction__c: totals.tax.label, Tax_Rate__c: totals.tax.rate });
      // Brand block: per-tenant config when that surface lands (service-workflows.md
      // §12). Until then the document renders with the tenant slug as the name so the
      // layout can be reviewed; the real identity block is a GET-FROM-HARMON item.
      const { payer } = await recipientRecords({ payerId: estimatePayerId(est), tenantId }); // the "Bill to" block (D-081 amendment 2)
      const { html, title } = renderEstimateDocument({ estimate: est, lines, totals, brand: brandFor(ctx), payer, options: { mode: "preview" } });
      return jsonResponse(200, cors, { html, title, version: Number(est.Version__c) || 0 });
    },

    /**
     * GET /service/estimates/{id}/pdf (2026-10-22, D-072 amendment 15): the estimate AS IT
     * STANDS, through the same document model the send uses (buildEstimateModel → the PDF
     * painter), so the office can download it before sending. Watermarked DRAFT while Draft,
     * PREVIEW otherwise. Nothing is stored, the version does not move, the status does not
     * change. Returned as JSON { fileName, contentType, base64 }: the REST API has no binary
     * media types (a raw PDF would arrive as mangled text), and a signed URL would need a
     * stored file. An estimate PDF is tens of KB — far under the 6 MB response limit.
     */
    async estimatePdf({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      const lines = await loadLines(est.Id, tenantId);
      const totals = await estimateTotals(est, lines, { tenantId });
      if (!showsStoredTotals(est) && est.Status__c !== "Invoiced" && est.Is_Template__c !== true) Object.assign(est, { Tax_Jurisdiction__c: totals.tax.label, Tax_Rate__c: totals.tax.rate });
      const { payer } = await recipientRecords({ payerId: estimatePayerId(est), tenantId });
      const draft = est.Status__c === "Draft" || est.Status__c === "Template" || est.Is_Template__c === true;
      const watermark = draft ? "DRAFT" : "PREVIEW";
      let bytes;
      try {
        const model = buildEstimateModel({ estimate: est, lines, totals, brand: brandFor(ctx), payer, options: { mode: "pdf", watermark } });
        bytes = await d.renderPdf(model);
      } catch (e) {
        console.error(`estimate pdf: render failed for ${est.Id}: ${e?.message || e}`);
        return jsonResponse(502, cors, { error: "pdf_failed", code: "PDF_RENDER_FAILED", message: "The PDF could not be made. Try again." });
      }
      const fileName = `${String(est.Name || "estimate").replace(/[^A-Za-z0-9._-]+/g, "-")}-${watermark.toLowerCase()}.pdf`;
      return jsonResponse(200, cors, { fileName, contentType: "application/pdf", base64: Buffer.from(bytes).toString("base64"), version: Number(est.Version__c) || 0, watermark });
    },

    /**
     * POST /service/estimates/{id}/lines/reorder { lineIds } (2026-10-22): the office's order.
     * Every line of the estimate, once each — anything else is 400 REORDER_INVALID. Writes
     * Sort_Order__c 1..n (only the lines whose number moves) and recomputes NOTHING: money
     * does not depend on order. Every reader sorts Sort_Order__c NULLS LAST, CreatedDate, so
     * the page, both PDFs, the version log, the invoice and the job report follow.
     */
    async reorderLines({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const est = await loadEstimate(params[0], tenantId);
      if (!est) return notFound(cors);
      if (est.Status__c === "Invoiced") return jsonResponse(409, cors, { error: "locked", code: "ESTIMATE_INVOICED" });
      const ids = Array.isArray(body?.lineIds) ? body.lineIds.map(String) : null;
      const lines = await loadLines(est.Id, tenantId);
      const known = new Set(lines.map((l) => l.Id));
      if (!ids || ids.length !== lines.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
        return bad(cors, "REORDER_INVALID", "lineIds must list every line of this estimate exactly once.", { expected: lines.length });
      }
      const byId = new Map(lines.map((l) => [l.Id, l]));
      const moved = [];
      try {
        for (let i = 0; i < ids.length; i++) {
          const line = byId.get(ids[i]);
          if (Number(line.Sort_Order__c) === i + 1) continue;
          await d.sfUpdateRecord(LINE_SF_OBJECT, line.Id, { Sort_Order__c: i + 1 });
          moved.push(line.Id);
        }
        // The estimate's own SystemModstamp moves too (a same-value write), so a page that
        // loaded it before the reorder sees it changed.
        if (moved.length) await d.sfUpdateRecord(ESTIMATE_SF_OBJECT, est.Id, { Status__c: est.Status__c });
      } catch (e) {
        return sfError(cors, e, "line reorder");
      }
      if (!moved.length) return jsonResponse(200, cors, { success: true, unchanged: true, lineIds: ids });
      await markStale(CACHE.line, moved, tenantId);
      await markStale(CACHE.estimate, [est.Id], tenantId);
      await act(ctx, { event: EVENTS.ESTIMATE_UPDATED, recordType: "estimate", recordSfId: est.Id, estimateSfId: est.Id, jobSfId: est.Service_Job__c ?? null, details: { reordered: true, order: ids, moved: moved.length } });
      return jsonResponse(200, cors, { success: true, lineIds: ids, moved: moved.length });
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
      // 2. The still itself — requested by ADDRESS, not by panorama id. Asked for a pano
      //    id, Google shows that panorama's default heading (the way the camera car was
      //    facing), which on a residential street is the house across the road. Asked
      //    for a location, Google picks the nearest outdoor panorama AND aims the camera
      //    at the address (2026-09-12: Tim's own house came out as the neighbour's).
      const key = streetViewKey(job.Id, d.now());
      try {
        const img = await d.fetchUrl(
          `https://maps.googleapis.com/maps/api/streetview?size=${STREET_VIEW_SIZE}&${q}&fov=80&pitch=0`
        );
        if (!img.ok) throw new Error(`HTTP ${img.status}`);
        const bytes = Buffer.from(await img.arrayBuffer());
        await d.putObject({ key, body: bytes, contentType: "image/jpeg" });
      } catch (e) {
        console.error("street-view image", e?.message);
        return jsonResponse(502, cors, { error: "street_view_failed", code: "STREET_VIEW_FAILED", message: "Couldn't fetch the image." });
      }
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Street_View_Image_Key__c: key });
      // The previous still (a refresh, or an address change that cleared the pointer but not
      // the file) is removed so the Files tab does not fill with old houses. Best-effort:
      // the role may lack s3:DeleteObject, and a leftover file is a nuisance, not a fault.
      if (current && current !== STREET_VIEW_NONE && current !== key && isStreetViewKey(current) && d.deleteObject) {
        try {
          await d.deleteObject({ key: current });
        } catch (e) {
          console.error("street-view: old image not removed:", e?.message || e);
        }
      }
      return jsonResponse(200, cors, { status: "ready", url: publicUrlForKey(key), key, cached: false, panoLocation: meta.location ?? null });
    },
    /** The tech app's read of the same still (2026-09-19): fetched on first use like the office's, never refreshed from the phone. */
    async techJobStreetView(args) {
      return H.jobStreetView({ ...args, query: {} });
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

  /**
   * The two records the send box reads (lib/send-to.js): the payer (only when someone other
   * than the homeowner pays) and the document's own customer, tenant-scoped, in one query.
   * Best-effort: a failed read falls back to the snapshot fields.
   */
  async function recipientRecords({ payerId = null, customerId = null, tenantId }) {
    const ids = [payerId, customerId].filter((x) => SF_ID_RE.test(x || ""));
    let rows = [];
    if (ids.length) {
      try {
        rows = await d.sfQuery(
          `SELECT ${RECIPIENT_RECORD_SELECT} FROM ${CUSTOMER_SF_OBJECT} WHERE Id IN (${[...new Set(ids)].map((x) => `'${soqlEscapeString(x)}'`).join(", ")}) ` +
            `AND Client__c = '${soqlEscapeString(tenantId)}'`
        );
      } catch (e) {
        console.error("send-to: recipient read failed:", e?.sfBody || e?.message || e);
      }
    }
    // Exact id; a 15-character id (Salesforce's case-sensitive short form) matches its 18-character record.
    const byId = (id) => (rows || []).find((r) => id && r.Id && (r.Id === id || (String(id).length === 15 && r.Id.slice(0, 15) === id))) || null;
    return { payer: payerId ? byId(payerId) : null, customer: byId(customerId) };
  }
  /** An estimate's payer id: its Bill_To_Customer__c when someone other than the homeowner pays. */
  const estimatePayerId = (est) => (est?.Bill_To_Type__c && est.Bill_To_Type__c !== BILL_TO_SELF ? est.Bill_To_Customer__c || null : null);
  const estimateSnapshot = (est) => ({ email: est?.Primary_Email_at_Creation__c, phone: est?.Primary_Phone_at_Creation__c, name: est?.Customer_Name_at_Creation__c });
  /** What GET /service/estimates/{id} adds (D-081 amendment 2 + D-072 amendment 12): who pays, and the send box's prefill. */
  async function estimateReadExtras(est, tenantId) {
    const billTo = { type: est.Bill_To_Type__c || BILL_TO_SELF, customerId: est.Bill_To_Customer__c ?? null, name: est.Bill_To_Name__c ?? null };
    if (est.Is_Template__c === true) return { billTo, sendDefaults: null };
    const recs = await recipientRecords({ payerId: estimatePayerId(est), customerId: est.Sundial_Customer__c, tenantId });
    return { billTo, sendDefaults: sendDefaults({ ...recs, snapshot: estimateSnapshot(est) }) };
  }
  /**
   * The Bill To fields for an estimate write (D-081 amendment 2): the job's rule, the same
   * resolveBillTo — type says what kind, the customer says who, the name is derived.
   * `src` holds billToType / billToCustomerId (either may be absent = not touched).
   */
  async function estimateBillTo(src, before, tenantId) {
    const has = (k) => src && Object.prototype.hasOwnProperty.call(src, k);
    return resolveBillTo({
      type: has("billToType") ? strOrNull(src.billToType) ?? "" : undefined,
      customerId: has("billToCustomerId") ? src.billToCustomerId : undefined,
      before,
      loadCustomer: billToCustomerLoader({ sfQuery: d.sfQuery, soqlEscapeString, tenantId }),
    });
  }
  // Money: one core (loaders + settleMoney) shared by the invoice routes and Stripe.
  const money = createMoneyCore(d, { act, markStale, CACHE, publicEstimateUrl: (token, ctx) => publicEstimateUrl(token, publicBaseFor(ctx)), randomToken: d.randomToken });
  // The Service Club (D-073): public join / truck roll / request, the office's memberships,
  // and the webhook's subscription branch (consulted by stripe.js before the payments branch).
  const club = createClubHandlers(d, { resolveCustomer, createEstimateRecord, createJobRecord, addLinesToEstimate, loadEstimate, loadLines, recomputeAndStore, estimateTotals, act, markStale, flushEvents, CACHE, jsonResponse, bad, notFound, sfError, brandFor, publicBaseFor, notifier: d.notifier });
  Object.assign(H, club.handlers);
  const stripeH = createStripeHandlers(d, { money, act, markStale, brandFor, jsonResponse, bad, notFound, sfError, CACHE, club, notifier: d.notifier, publicEstimateUrl: (token, ctx) => publicEstimateUrl(token, publicBaseFor(ctx)), randomToken: d.randomToken, portalBaseUrl: (ctx) => publicBaseFor(ctx) });
  Object.assign(H, createInvoiceHandlers(d, { loadEstimate, loadLines, estimateTotals, act, markStale, brandFor, jsonResponse, bad, notFound, sfError, CACHE, customerEmailFor, recipientRecords, money })); // issue never charges a card (2026-10-19): chargeInvoice is the Charge card route's alone
  H.chargeInvoiceRoute = stripeH.chargeInvoiceRoute;
  H.stripeWebhook = stripeH.stripeWebhook;
  H.jobCard = stripeH.jobCard;
  H.jobCardSession = stripeH.jobCardSession;
  H.jobCardLink = stripeH.jobCardLink;
  H.jobCharge = stripeH.jobCharge;
  Object.assign(H, createAddressHandlers(d, { jsonResponse, bad }));
  Object.assign(H, createLaborHandlers(d, { loadEstimate, loadLines, recomputeAndStore, act, markStale, jsonResponse, bad, notFound, sfError, CACHE, tenantSettings, fieldExists, estimateTotals }));
  // The customer's job report + receipt (D-072 amendment 10). Texting goes through the same
  // sender the board uses (lib/sms-send.js) so the text lands on the job's conversation.
  if (!d.sms) d.sms = createSmsSender({ getSecret: d.getSecret, getSupabaseClient: d.getSupabaseClient, sfQuery: d.sfQuery, now: d.now, ...(d.sendSms ? { sendSms: d.sendSms } : {}), ...(d.broadcast ? { broadcast: d.broadcast } : {}) });
  Object.assign(H, createReportHandlers(d, { publicBaseFor, noPublicUrlDetail, loadEstimate, loadLines, act, markStale, brandFor, jsonResponse, bad, notFound, sfError, CACHE, customerEmailFor, money, loadJobCalls: (jobId, tenantId) => d.sfQuery(`SELECT Id, Name, Scheduled_Start__c, Actual_Start__c, Tech__c, Tech__r.First_Name__c, Tech__r.Last_Name__c FROM ${CALL_SF_OBJECT} WHERE Sundial_Service_Job__c = '${soqlEscapeString(jobId)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 200`) }));

  // Action key per route family (lib/access.js ACTION_SCOPES — all tenant-only).
  const ACTION_FOR = {
    createEstimate: "service.estimate.write", getEstimate: "service.estimate.write", patchEstimate: "service.estimate.write",
    addLine: "service.estimate.write", patchLine: "service.estimate.write", deleteLine: "service.estimate.write",
    addTemplate: "service.estimate.write", recalculate: "service.estimate.write", sendEstimate: "service.estimate.send",
    approveEstimate: "service.estimate.send", declineEstimate: "service.estimate.send",
    createJobFromEstimate: "service.job.create", createJob: "service.job.create",
    createServiceCustomer: "service.estimate.write", // a lead is not an estimate yet; whoever can start one can log one
    createItem: "service.pricebook.write", patchItem: "service.pricebook.write",
    newItemVersion: "service.pricebook.write", deactivateItem: "service.pricebook.write",
    jobActivity: ["service.estimate.write", "service.tech.read"], estimateActivity: "service.estimate.write", // the tech app reads the job's feed
    previewEstimate: "service.estimate.write", estimatePdf: "service.estimate.write", reorderLines: "service.estimate.write", jobStreetView: "service.estimate.write", techJobStreetView: "service.tech.read",
    suggestAddress: "service.estimate.write", resolveAddress: "service.estimate.write", // whoever can make an estimate can make its customer
    listTaxZones: "service.estimate.write", setJobTaxZone: "service.estimate.write", // D-083: whoever prices the job picks its zone
    getJobInvoice: "service.estimate.write", getInvoice: "service.estimate.write", previewInvoice: "service.estimate.write",
    unlockEstimate: "service.estimate.write", // whoever may edit the estimate may reopen it; the invoice is not touched
    invoiceReport: "service.estimate.write", // a read, like getInvoice
    issueInvoice: "service.invoice.write", recordPayment: "service.invoice.write", recordJobDeposit: "service.invoice.write", sendInvoice: "service.invoice.write", voidInvoice: "service.invoice.write",
    chargeInvoiceRoute: "service.card.charge", // amendment 11: charging a stored card is a level-gated action, everywhere
    jobCard: "service.invoice.write", jobCardSession: "service.invoice.write", jobCardLink: "service.invoice.write",
    jobCharge: "service.card.charge", // Admin / Executive / Manager (lib/access.js ACTION_LEVELS; Managers since 2026-10-16)
    getLabor: "service.estimate.write", saveLabor: "service.invoice.write", setDefaultRate: "service.invoice.write",
    getCosting: "service.costing.read", setDefaultCostRate: "service.costing.write", listRates: "service.costing.read",
    getReport: "service.estimate.write", saveReport: "service.estimate.write", previewReport: "service.estimate.write", prepareReport: "service.estimate.send", sendReport: "service.estimate.send",
    techAddLines: "service.tech.self",
    // Service Club (D-073): reads for anyone in the office, writes their own key.
    clubPlansOffice: "service.club.read", clubMemberships: "service.club.read", clubReport: "service.club.read", clubCustomer: ["service.club.read", "service.estimate.write"],
    clubPatchPlan: "service.club.write", clubCreateMembership: "service.club.write", clubCancel: "service.club.write", clubResendSolarFacts: "service.club.write",
    applyPlanDiscount: "service.estimate.write",
  };

  return async function handler(event) {
    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

    const route = matchRoute(method, event?.rawPath || event?.path || "");
    if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });

    // Stripe calls us with no bearer token: the signature check inside is the whole gate.
    if (route.name === "stripeWebhook") {
      try {
        return await H.stripeWebhook({ params: route.params, event, headers, cors });
      } catch (err) {
        console.error("stripe webhook error:", err?.message || err);
        return jsonResponse(500, cors, { error: "server_error", route: route.name });
      }
    }
    // The club's public pages (D-073): no login; the tenant is the URL's slug, every write
    // is a Stripe Checkout the customer completes on Stripe's page or a job for the office.
    if (PUBLIC_ROUTES.has(route.name)) {
      await warmBrand(route.params[0] ?? null); // the slug is the first path segment on every public club route
      let pub = {};
      if (method === "POST") {
        const parsed = parseJsonBody(event);
        if (!parsed.ok && event?.body) return bad(cors, "INVALID_BODY", "Body must be JSON.");
        pub = parsed.ok ? parsed.data : {};
      }
      try {
        return await H[route.name]({ params: route.params, body: pub, query: event?.queryStringParameters || {}, cors });
      } catch (err) {
        console.error(`service-club ${route.name} error:`, err?.sfBody || err?.message || err);
        return jsonResponse(500, cors, { error: "server_error", route: route.name });
      }
    }

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
    if (identity?.tenantSlug) slugByTenant.set(tenantId, identity.tenantSlug); // the tax tables' key (D-083)
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
      await warmBrand(identity?.tenantSlug ?? null);
      const ctx = {
        tenantId,
        tenantSlug: identity?.tenantSlug ?? null,
        userId: u.id ?? null,
        scope: identity?.access?.scope ?? null,
        actor: { id: u.id ?? null, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || null },
        // The signed-in person's Supabase profile — the author of the feed's system lines (D-084).
        profileId: identity?.authUserId ?? null,
        cors,
        // A handler that does a second, narrower thing inside a broader route asks this
        // (issue with "charge the card" is the office's route, the charge is an Admin's).
        can: (key) => canAction(key, alwaysEnforcedAccess(identity) ?? identity?.access ?? null),
      };
      // Markup on a new estimate (New Estimate / New Job's `estimate` block): the PATCH rule.
      if ((route.name === "createEstimate" || route.name === "createJob") && body?.estimate && typeof body.estimate === "object") {
        const mg = markupGate(ctx, body.estimate);
        if (!mg.ok) return costForbidden(cors, mg);
        body = { ...body, estimate: mg.fields };
      }
      const res = await H[route.name]({ ctx, params: route.params, body, query: event?.queryStringParameters || {} });
      return ctx.can(COSTING_READ) ? res : withoutMarkup(res);
    } catch (err) {
      console.error(`service-estimate ${route.name} error:`, err?.sfBody || err?.message || err);
      return jsonResponse(500, cors, { error: "server_error", route: route.name });
    }
  };
}

export const handler = createHandler();
