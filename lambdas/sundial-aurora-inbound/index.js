// sundial-aurora-inbound — SQS worker for Aurora's agreement_status_changed events.
//
// The doorbell (sundial-aurora-webhook) authenticates Aurora's GET, enqueues, and
// acks inside Aurora's 10-second deadline. THIS Lambda does the slow work:
//
//   ALL statuses  -> update agreement-tracking state on Sundial_Customer__c
//   signed        -> also sets the pipeline position: Status__c = "Customer" and
//                    Stage__c = "Sold - Pending Review" (Tim, 2026-08-10). Aurora's
//                    `signed` means exactly that in Sundial, for BOTH an
//                    auto-created dealer customer and a pre-existing matched one.
//                    Harmon's Salesforce alerts fire off that Stage, so this write
//                    is the notification path — the email channel is deliberately
//                    left unconfigured.
//   signed        -> additionally:
//                      a. GET agreement (confirm), design summary, default
//                         proposal, financing (SKIPPED when FINANCING_ID is empty)
//                      b. write the mapped fields back to the customer
//                      c. generate + download the signed PDF and store it at
//                         SUNDIAL/{customerId}/{AGREEMENT_ID}-signed-agreement.pdf
//                      d. email the design manager (once)
//
// EVERYTHING WRITES TO Sundial_Customer__c. No Sundial_Solar__c record exists at
// this point in the lifecycle (it is created after the proposal is signed and the
// docs are processed) and this worker must never create one — see D-047/D-048.
//
// UNMATCHED PROJECTS (D-049): Harmon's third-party dealers originate deals entirely
// inside Aurora, in the same tenant, so their agreement events arrive with no
// matching Sundial_Customer__c. A SIGNED one now branches on the project's
// external_provider_id: present-and-resolvable = OUR deal with a broken link
// (repair it), absent = dealer origination (create the customer by upsert on the
// Aurora_Project_ID__c external id), present-but-unresolvable = refuse. Non-signed
// unmatched events create nothing and are dropped quietly unless they carry a
// provider id. See handleUnmatched.
//
// IDEMPOTENCY (Aurora warns duplicates ARE possible and ordering is NOT guaranteed):
//   - status writes dedupe on (agreement_id, status) and obey STATUS_RANK, so a
//     late `viewed` cannot regress a `signed`;
//   - the negative terminal statuses (canceled / cancel-pending / declined) are the
//     one case order cannot settle, so they are CONFIRMED with Aurora before being
//     applied: if Aurora agrees the agreement is dead it wins even over a recorded
//     `signed` (and notifies); if Aurora still says `signed` the event is dropped
//     as stale. See processEvent;
//   - a `signed` event whose re-read shows a dead agreement records Aurora's status
//     and sends the SAME cancellation notification — the design team hears about a
//     dead contract whether we learned it from a `canceled` event or from the
//     re-read on a `signed` one;
//   - the field write-back is a plain PATCH of derived values — replaying it is a
//     no-op;
//   - the PDF key is deterministic, so a duplicate overwrites instead of piling up;
//   - the email is gated on Aurora_Signed_Email_Sent__c, so a duplicate signed
//     event does not re-notify.
//   A duplicate `signed` therefore re-does nothing already done, while a PARTIAL
//   first run (e.g. PDF failed) is resumed by the retry — that split is the whole
//   point of tracking the steps separately.
//
// TENANT SCOPING: this worker is system-initiated, so there is no caller token and
// no tenant to derive from one. The customer is found by its globally-unique Aurora
// project id, and every subsequent read/write is scoped to THAT record's own
// Client__c. Nothing cross-object and nothing cross-tenant is ever written.
//
// FAILURE HANDLING: failed messages are reported via batchItemFailures so SQS
// redrives them to the DLQ per the queue's redrive policy. Errors are classified:
//   PERMANENT (PermanentEventError) — ambiguous project match, provider-id
//     mismatch, an unmatched NON-signed event that carries a provider id, missing
//     design_id on a signed event, or a 403 from Aurora ("endpoint not provisioned
//     for our key"). Logged with a PERMANENT marker; retrying cannot help, and the
//     DLQ is where a human should see it.
//   RETRYABLE — everything else (network blips, Salesforce 5xx, an expired
//     file_url). The next receive re-runs from the top; every step is idempotent.
//
// Value-safety: never logs tokens, secrets, api keys, or the presigned file_url.

import {
  sfQuery,
  soqlEscapeString,
  sfUpdateRecord,
  describeObject,
} from "../../lib/salesforce.js";
import {
  AuroraError,
  getAgreement,
  getDesignSummary,
  getDefaultProposal,
  getFinancing,
  getProject,
  fetchSignedAgreementUrl,
  downloadSignedAgreement,
} from "../../lib/aurora.js";
import {
  createCustomerFromAuroraProject,
  buildSignedPipelineFields,
  resolveTenantId,
  EXTERNAL_ID_FIELD,
} from "./customerCreate.js";
import { parseSqsRecords } from "../../lib/sqs.js";
import {
  buildKey,
  sanitizeFileName,
  registerFileMetadata,
  S3_BUCKET,
  S3_REGION,
} from "../../lib/file-access.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  normalizeStatus,
  shouldApplyStatus,
  buildSignedFieldMap,
  NEGATIVE_TERMINAL_STATUSES,
} from "./mapping.js";
import { sendSignedNotification, sendCancellationNotification } from "./notify.js";

const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";

// New agreement-lifecycle fields. NONE of these exist on the org yet (verified by
// describe 2026-08-03), so every one is written behind the describe guard: absent
// fields are dropped from the PATCH instead of failing it. See TASKS.md.
const F_AGREEMENT_ID = "Aurora_Agreement_ID__c";
const F_AGREEMENT_STATUS = "Aurora_Agreement_Status__c";
const F_AGREEMENT_STATUS_AT = "Aurora_Agreement_Status_At__c";
const F_PROPOSAL_LINK = "Aurora_Proposal_Link__c";
const F_SIGNED_EMAIL_SENT = "Aurora_Signed_Email_Sent__c";

// Base fields (all confirmed to exist) plus the tracking fields, which are
// intersected with the live describe before they reach a SELECT or a PATCH.
const CUSTOMER_BASE_FIELDS = [
  "Id",
  "Name",
  "First_Name__c",
  "Last_Name__c",
  "City__c",
  "State__c",
  "Client__c",
  "Aurora_Project_ID__c",
];
const CUSTOMER_OPTIONAL_FIELDS = [
  F_AGREEMENT_ID,
  F_AGREEMENT_STATUS,
  F_AGREEMENT_STATUS_AT,
  F_PROPOSAL_LINK,
  F_SIGNED_EMAIL_SENT,
];

const s3 = new S3Client({ region: S3_REGION });

/** Trim a possibly-null Salesforce/Aurora value to a clean string ("" when absent). */
function cleanStr(v) {
  return v == null ? "" : String(v).trim();
}

/** Errors that will never succeed on retry — they belong in the DLQ, not a loop. */
class PermanentEventError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "PermanentEventError";
    this.permanent = true;
    this.code = code ?? "PERMANENT";
  }
}

// --- describe guard ---------------------------------------------------------
// Same pattern as the design-request submit: intersect the fields we want with the
// fields the org actually has, in the describe's canonical casing.
async function resolveCustomerSchema() {
  const describe = await describeObject(CUSTOMER_SF_OBJECT);
  const byLower = new Map(
    (describe.fields || []).map((f) => [f.name.toLowerCase(), f])
  );
  const present = new Set();
  const missing = [];
  for (const api of CUSTOMER_OPTIONAL_FIELDS) {
    const hit = byLower.get(api.toLowerCase());
    if (hit) present.add(hit.name);
    else missing.push(api);
  }
  // Active picklist values for any field, so mapping code can match against what
  // the org ACTUALLY has rather than a hardcoded list.
  const picklistValues = (name) =>
    (byLower.get(String(name).toLowerCase())?.picklistValues || [])
      .filter((p) => p.active !== false)
      .map((p) => p.value);

  return {
    // General existence check across the whole object (not just the tracking
    // fields) — the auto-create mapping guards every field through this.
    has: (name) => byLower.has(String(name).toLowerCase()),
    missingOptional: missing,
    allFields: byLower,
    picklistValues,
    partnerPicklistValues: picklistValues("Financing_Partner__c"),
    selectFields: [...CUSTOMER_BASE_FIELDS, ...present],
  };
}

/** Drop any field the org doesn't have, so a PATCH can't fail on a missing field. */
function filterToExisting(fields, schema) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(fields)) {
    if (schema.allFields.has(k.toLowerCase())) out[schema.allFields.get(k.toLowerCase()).name] = v;
    else dropped.push(k);
  }
  return { fields: out, dropped };
}

// --- customer resolution ----------------------------------------------------
/**
 * Find the customer by Aurora project id. No caller tenant exists here, so the
 * lookup is by the globally-unique Aurora id and the record's OWN Client__c is
 * what scopes everything afterwards.
 *
 * Ambiguity and no-match are PERMANENT: guessing which customer a signed contract
 * belongs to is far worse than dead-lettering it for a human.
 */
async function resolveCustomerByAuroraProject(projectId, schema) {
  const soql =
    `SELECT ${schema.selectFields.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
    `WHERE Aurora_Project_ID__c = '${soqlEscapeString(projectId)}' ` +
    `LIMIT 2`;
  const rows = await sfQuery(soql);
  if (!rows || rows.length === 0) {
    // NOT an error any more: it may be a dealer-originated deal (create it) or one
    // of ours whose write-back never landed (repair it). handleUnmatched decides.
    return null;
  }
  if (rows.length > 1) {
    throw new PermanentEventError(
      `Multiple Sundial_Customer__c records carry Aurora_Project_ID__c = "${projectId}" — ambiguous, refusing to guess.`,
      { code: "AMBIGUOUS_CUSTOMER_MATCH" }
    );
  }
  return rows[0];
}

/** Load one customer by Salesforce id, scoped to this deployment's tenant. */
async function loadCustomerById(recordId, schema) {
  const tenantId = await resolveTenantId();
  const soql =
    `SELECT ${schema.selectFields.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' ` +
    `LIMIT 1`;
  const rows = await sfQuery(soql);
  return rows?.[0] ?? null;
}

/**
 * No customer carries this Aurora project id. Work out which of the three cases it
 * is — and note that the answer depends on `external_provider_id`, which is only
 * knowable by asking Aurora (D-049).
 *
 *   1. provider id present AND resolves  -> OUR deal whose design-request
 *      write-back never landed (pushed_writeback_failed). REPAIR the link.
 *   2. provider id absent                -> genuine dealer origination. CREATE
 *      (signed only — Harmon wants customers for deals that actually sell).
 *   3. provider id present, resolves to nothing (or another tenant) -> refuse.
 *
 * Non-signed events never create: a dealer's pre-sale sent/viewed traffic is
 * DROPPED quietly rather than dead-lettered, because it is normal and would
 * otherwise fill the DLQ with noise. The exception is a non-signed event that DOES
 * carry a provider id — that is our own broken deal and still deserves a human.
 *
 * @returns {Promise<{ drop?: true, reason?: string, customer?: object,
 *                     repaired?: boolean, autoCreate?: object }>}
 */
async function handleUnmatched({ evt, status, schema }) {
  // Retrieve Project is the authority for every branch below. A 403 here is fatal
  // to the whole feature (AuroraError.notProvisioned -> loud permanent dead-letter).
  const project = await getProject(evt.project_id);
  const providerId = cleanStr(project?.external_provider_id);

  if (status !== "signed") {
    if (providerId) {
      throw new PermanentEventError(
        `Unmatched "${status}" for Aurora project ${evt.project_id}, which carries external_provider_id "${providerId}" — this is a Sundial-originated deal with a broken Aurora_Project_ID__c link, not dealer traffic.`,
        { code: "UNMATCHED_WITH_PROVIDER_ID" }
      );
    }
    // Normal, expected, and not worth a DLQ entry.
    console.log(
      `aurora-inbound: unmatched dealer-origin event (${status}) for Aurora project ${evt.project_id} — ignoring until signed.`
    );
    return { drop: true, reason: "unmatched_dealer_origin_pre_sale" };
  }

  // --- signed ---
  if (providerId) {
    const existing = await loadCustomerById(providerId, schema);
    if (!existing) {
      throw new PermanentEventError(
        `Aurora project ${evt.project_id} has external_provider_id "${providerId}", but no Sundial_Customer__c with that id exists in this tenant.`,
        { code: "PROVIDER_ID_MISMATCH" }
      );
    }
    // REPAIR: the Aurora project was ours all along; only the write-back failed
    // (the aurora-push "pushed_writeback_failed" outcome). Restore the link and
    // carry on — creating anything here would duplicate a real customer.
    await sfUpdateRecord(CUSTOMER_SF_OBJECT, existing.Id, {
      [EXTERNAL_ID_FIELD]: evt.project_id,
    });
    console.warn(
      `aurora-inbound: REPAIRED missing ${EXTERNAL_ID_FIELD} on customer ${existing.Id} -> Aurora project ${evt.project_id} (design-request write-back had failed).`
    );
    return {
      customer: { ...existing, [EXTERNAL_ID_FIELD]: evt.project_id },
      repaired: true,
    };
  }

  // CREATE: a real dealer-originated sale.
  const autoCreate = await createCustomerFromAuroraProject({
    project,
    projectId: evt.project_id,
    agreementId: evt.agreement_id,
    receivedAt: evt.received_at,
    schema,
  });
  console.warn(
    `aurora-inbound: AUTO-CREATED customer ${autoCreate.id} from dealer-originated Aurora project ${evt.project_id} (dealer: ${autoCreate.dealerName || "unresolved"}, created=${autoCreate.created}).`
  );

  // Re-read so the rest of the pipeline sees the full, real field set.
  const customer = await loadCustomerById(autoCreate.id, schema);
  if (!customer) {
    throw new Error(
      `Auto-created customer ${autoCreate.id} could not be read back for Aurora project ${evt.project_id}.`
    );
  }
  return { customer, autoCreate };
}

/**
 * Cross-check the design's external_provider_id (which we set to the SF customer
 * id when creating the Aurora project) against the customer we resolved. A
 * mismatch means the two systems disagree about who this is — dead-letter rather
 * than write a signed contract onto the wrong customer.
 */
function assertProviderIdMatches(design, customer) {
  const provider = String(design?.external_provider_id ?? "").trim();
  if (!provider) return; // not always populated — absence is not a mismatch
  // Salesforce ids come in 15- and 18-char forms; compare on the 15-char prefix.
  const norm = (id) => String(id ?? "").trim().slice(0, 15);
  if (norm(provider) !== norm(customer.Id)) {
    throw new PermanentEventError(
      `Aurora design external_provider_id "${provider}" does not match the customer resolved by project id (${customer.Id}).`,
      { code: "PROVIDER_ID_MISMATCH" }
    );
  }
}

// --- signed: the PDF --------------------------------------------------------
/**
 * Generate, download, and store the signed agreement PDF.
 *
 * The file_url expires 15 minutes after generation, so the bytes are fetched
 * immediately after the job succeeds and the URL is never persisted or logged.
 * The key is deterministic, so a duplicate event overwrites in place.
 *
 * @returns {Promise<{ key: string, bytes: number }>}
 */
async function storeSignedPdf({ agreementId, customer }) {
  const { fileUrl } = await fetchSignedAgreementUrl(agreementId);
  const body = await downloadSignedAgreement(fileUrl);

  const fileName = sanitizeFileName(`${agreementId}-signed-agreement.pdf`);
  const key = buildKey(customer.Id, fileName);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/pdf",
    })
  );
  // The Dropbox mirror picks this up from the S3 event — never called from here.

  // Best-effort metadata row (the Files tab lists from S3, so this is only for the
  // documented metadata-backed design). Never fails the store.
  try {
    const supabase = await getSupabaseClient();
    await registerFileMetadata(supabase, {
      s3Key: key,
      fileName,
      tenantId: customer.Client__c ?? null,
      sfRecordId: customer.Id,
      sfObjectType: CUSTOMER_SF_OBJECT,
      uploadedByUserId: null,
      uploadedByUserName: "Sundial (Aurora signed agreement)",
      fileSizeBytes: body.byteLength,
      mimeType: "application/pdf",
      category: "Signed Agreement",
      subfolder: null,
    });
  } catch (e) {
    console.error(
      `aurora-inbound: file metadata register failed for ${key}: ${e?.message || e}`
    );
  }

  return { key, bytes: body.byteLength };
}

// --- signed: the whole path -------------------------------------------------
async function processSigned({ evt, customer, schema, providerCheck = "strict" }) {
  const warnings = [];
  const agreementId = evt.agreement_id;

  if (!evt.design_id) {
    throw new PermanentEventError(
      `Signed event for agreement ${agreementId} carries no design_id — the design, proposal, and financing cannot be retrieved.`,
      { code: "MISSING_DESIGN_ID" }
    );
  }

  // a) Retrievals. The agreement GET confirms Aurora agrees it is signed (the
  //    webhook could be stale or out of order).
  const agreement = await getAgreement(agreementId);
  const confirmed = normalizeStatus(agreement?.status);
  if (confirmed !== "signed") {
    // Not an error: Aurora is the authority, and the status moved on. Record what
    // Aurora says and skip the signed-only work.
    console.warn(
      `aurora-inbound: agreement ${agreementId} is "${confirmed}" per Aurora, not "signed" — skipping signed processing.`
    );
    return { skipped: true, confirmedStatus: confirmed, warnings };
  }

  const design = await getDesignSummary(evt.design_id);
  if (providerCheck === "strict") {
    assertProviderIdMatches(design, customer);
  } else {
    // Auto-created record: the customer was born from THIS Aurora project moments
    // ago, so comparing its brand-new id against a provider id is meaningless.
    // Provenance was already settled from the project (its external_provider_id was
    // empty — that is what made this dealer-originated). If the DESIGN nonetheless
    // carries one, Aurora's own objects disagree: say so loudly rather than
    // dead-letter, which would strand the customer we just created.
    const designProvider = cleanStr(design?.external_provider_id);
    if (designProvider) {
      warnings.push(
        `Aurora inconsistency: the project had no external_provider_id (so this was treated as dealer-originated and a new customer was created), but the design reports external_provider_id "${designProvider}". Check whether this deal already exists in Sundial.`
      );
      console.warn(
        `aurora-inbound: project ${evt.project_id} had no external_provider_id but design ${evt.design_id} reports "${designProvider}" — possible duplicate customer ${customer.Id}.`
      );
    }
  }

  // The proposal is a nice-to-have link; never fail the contract write-back over it.
  let proposal = null;
  try {
    proposal = await getDefaultProposal(evt.design_id);
  } catch (e) {
    if (e instanceof AuroraError && e.notProvisioned) throw e; // 403 must surface
    warnings.push(`Could not retrieve the default proposal: ${e?.message || e}`);
  }

  // EMPTY FINANCING_ID = no financing option was selected on the design. Aurora's
  // rule is to skip the call entirely — requesting it would 404.
  let financing = null;
  if (evt.financing_id) {
    financing = await getFinancing(evt.design_id, evt.financing_id);
  } else {
    warnings.push(
      "No financing was selected on the Aurora design (empty FINANCING_ID) — price, financing type/partner, and payment fields were not written."
    );
  }

  // b) Field mapping + write-back.
  const { fields: mapped, warnings: mapWarnings } = buildSignedFieldMap({
    design,
    financing,
    proposal,
    receivedAt: evt.received_at,
    partnerPicklistValues: schema.partnerPicklistValues,
  });
  warnings.push(...mapWarnings);

  const { fields: writable, dropped } = filterToExisting(mapped, schema);
  if (dropped.length > 0) {
    warnings.push(
      `Salesforce is missing field(s) ${dropped.join(", ")} — those values were not written. Create them to capture this data.`
    );
  }
  if (Object.keys(writable).length > 0) {
    await sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, writable);
  }

  // c) Signed PDF. A failure here is recoverable on the next receive (the job can
  //    be re-run), so it does not roll back the field write-back above.
  let pdfKey = null;
  try {
    const stored = await storeSignedPdf({ agreementId, customer });
    pdfKey = stored.key;
  } catch (e) {
    if (e instanceof AuroraError && e.notProvisioned) throw e; // 403 must surface
    warnings.push(`Signed PDF was NOT saved: ${e?.message || e}`);
    console.error(
      `aurora-inbound: PDF store failed for agreement ${agreementId}: ${e?.message || e}`
    );
  }

  return { skipped: false, warnings, design, financing, proposal, fields: writable, pdfKey };
}

// --- one event --------------------------------------------------------------
async function processEvent(evt) {
  const status = normalizeStatus(evt.status);
  const schema = await resolveCustomerSchema();

  let customer = await resolveCustomerByAuroraProject(evt.project_id, schema);
  let autoCreate = null;
  let repaired = false;

  if (!customer) {
    const outcome = await handleUnmatched({ evt, status, schema });
    if (outcome.drop) {
      // Dealer traffic before the sale: acked and forgotten, NOT dead-lettered.
      return { status, applied: false, reason: outcome.reason, projectId: evt.project_id };
    }
    customer = outcome.customer;
    autoCreate = outcome.autoCreate ?? null;
    repaired = outcome.repaired === true;
  }

  // Status precedence + dedupe, evaluated against what the record says today.
  const currentStatus = schema.has(F_AGREEMENT_STATUS)
    ? customer[F_AGREEMENT_STATUS]
    : null;
  const currentAgreementId = schema.has(F_AGREEMENT_ID)
    ? customer[F_AGREEMENT_ID]
    : null;
  const decision = shouldApplyStatus(
    currentStatus,
    currentAgreementId,
    status,
    evt.agreement_id
  );

  // Was the signed work already completed for THIS agreement? The email marker is
  // the completion signal: it is only stamped after a notification actually sent.
  const alreadyNotified =
    schema.has(F_SIGNED_EMAIL_SENT) &&
    String(customer[F_SIGNED_EMAIL_SENT] ?? "").trim() !== "" &&
    normalizeStatus(currentStatus) === "signed" &&
    (!currentAgreementId || currentAgreementId === evt.agreement_id);

  // --- non-signed statuses: tracking state only ----------------------------
  if (status !== "signed") {
    // An exact duplicate is a duplicate however it got here — no Aurora call, no
    // write, and (critically) no repeat notification.
    if (!decision.apply && decision.reason === "duplicate") {
      console.log(
        `aurora-inbound: ignoring duplicate ${status} for agreement ${evt.agreement_id}.`
      );
      return { customerId: customer.Id, status, applied: false, reason: "duplicate" };
    }

    let statusToApply = status;
    let confirmedByAurora = false;

    // THE POST-SIGNATURE CANCELLATION FIX.
    // Delivery order cannot distinguish "this contract was genuinely canceled
    // after signing" from "a stale canceled arrived late", and nothing in Aurora's
    // payloads carries a status timestamp. So for the negative terminal statuses we
    // stop inferring and ASK: Aurora's current status is the authority.
    if (NEGATIVE_TERMINAL_STATUSES.has(status)) {
      const agreement = await getAgreement(evt.agreement_id);
      const confirmed = normalizeStatus(agreement?.status);

      if (confirmed === "signed") {
        // Aurora still considers it signed -> the event really was stale. Drop it,
        // exactly as precedence did before this fix.
        console.log(
          `aurora-inbound: dropping stale "${status}" for agreement ${evt.agreement_id} — Aurora still reports "signed".`
        );
        return {
          customerId: customer.Id,
          status,
          applied: false,
          reason: "stale_negative_status",
        };
      }

      if (NEGATIVE_TERMINAL_STATUSES.has(confirmed)) {
        // Confirmed dead. Aurora's value wins even if it differs from the webhook's
        // (e.g. the event said cancel-pending and it is now canceled), and it is
        // applied EVEN OVER a recorded `signed` — precedence is bypassed here
        // because we are no longer guessing about order.
        statusToApply = confirmed;
        confirmedByAurora = true;
      }
      // Any other current status (Aurora moved it back to sent/viewed, say) falls
      // through to the ordinary precedence rules below with the webhook's status.
    }

    if (!confirmedByAurora && !decision.apply) {
      console.log(
        `aurora-inbound: ignoring ${status} for agreement ${evt.agreement_id} (${decision.reason}; current=${currentStatus}).`
      );
      return { customerId: customer.Id, status, applied: false, reason: decision.reason };
    }

    const previousStatus = normalizeStatus(currentStatus) || null;
    const statusChanged = previousStatus !== statusToApply;

    if (confirmedByAurora && previousStatus === "signed") {
      // The case this fix exists for: loud in the logs as well as in the record and
      // the email, because downstream work may already be moving on a dead contract.
      console.warn(
        `aurora-inbound: agreement ${evt.agreement_id} for customer ${customer.Id} was recorded as SIGNED and Aurora now reports "${statusToApply}" — applying the cancellation over the signed status (confirmed with Aurora, not inferred).`
      );
    }

    const trackingFields = filterToExisting(
      {
        [F_AGREEMENT_ID]: evt.agreement_id,
        [F_AGREEMENT_STATUS]: statusToApply,
        [F_AGREEMENT_STATUS_AT]: evt.received_at,
      },
      schema
    ).fields;
    if (Object.keys(trackingFields).length > 0) {
      await sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, trackingFields);
    } else {
      console.warn(
        `aurora-inbound: no agreement-tracking fields exist on ${CUSTOMER_SF_OBJECT} (${schema.missingOptional.join(", ")}) — status "${statusToApply}" not recorded. Create the fields (see TASKS.md).`
      );
    }

    // Notify only on a CONFIRMED negative terminal status that actually changes
    // what Sundial had. The status-change gate is what stops repeat emails, so no
    // extra marker field is needed. Best-effort: never fails the status write.
    let email = null;
    if (confirmedByAurora && statusChanged) {
      email = await sendCancellationNotification({
        customer,
        event: evt,
        status: statusToApply,
        previousStatus,
      });
    }

    return {
      customerId: customer.Id,
      status: statusToApply,
      applied: true,
      ...(confirmedByAurora ? { confirmedByAurora: true, previousStatus } : {}),
      ...(email ? { email } : {}),
    };
  }

  // --- signed ---------------------------------------------------------------
  if (alreadyNotified) {
    // Fully processed already — a duplicate delivery. Do nothing at all.
    console.log(
      `aurora-inbound: agreement ${evt.agreement_id} already fully processed for customer ${customer.Id} — duplicate signed event ignored.`
    );
    return { customerId: customer.Id, status, applied: false, reason: "duplicate_signed" };
  }

  const result = await processSigned({
    evt,
    customer,
    schema,
    providerCheck: autoCreate ? "note" : "strict",
  });

  // Make the origin story part of the notification: whoever reads the signed email
  // should know this customer did not exist ten seconds ago, and who sold it.
  if (autoCreate) {
    result.warnings.unshift(
      `This customer was AUTO-CREATED from a dealer-originated Aurora project (dealer: ${autoCreate.dealerName || "unresolved"}). Review the record — it was built from Aurora data only.`,
      ...autoCreate.warnings
    );
  }
  if (repaired) {
    result.warnings.unshift(
      `${EXTERNAL_ID_FIELD} was missing on this customer and has been repaired — the original design-request write-back to Salesforce had failed.`
    );
  }

  if (result.skipped) {
    // Aurora says it is not signed; record ITS status instead and stop.
    const previousStatus = normalizeStatus(currentStatus) || null;
    const statusChanged = previousStatus !== result.confirmedStatus;

    if (previousStatus === "signed") {
      // Same alarm as the negative-terminal path: a signed event that turns out to
      // be a dead agreement contradicts a signature Sundial already acted on.
      console.warn(
        `aurora-inbound: agreement ${evt.agreement_id} for customer ${customer.Id} was recorded as SIGNED and Aurora now reports "${result.confirmedStatus}" — recording Aurora's status (confirmed on the signed event's re-read).`
      );
    }

    const trackingFields = filterToExisting(
      {
        [F_AGREEMENT_ID]: evt.agreement_id,
        [F_AGREEMENT_STATUS]: result.confirmedStatus,
        [F_AGREEMENT_STATUS_AT]: evt.received_at,
      },
      schema
    ).fields;
    if (Object.keys(trackingFields).length > 0) {
      await sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, trackingFields);
    }

    // A dead agreement is a dead agreement however we found out — this is the same
    // notification the negative-terminal path sends, so the design team hears about
    // it whether Aurora told us via a `canceled` event or via the re-read on a
    // `signed` one. Gated on the status actually changing, so a redelivered signed
    // event on an already-canceled record doesn't re-notify.
    let email = null;
    if (NEGATIVE_TERMINAL_STATUSES.has(result.confirmedStatus) && statusChanged) {
      email = await sendCancellationNotification({
        customer,
        event: evt,
        status: result.confirmedStatus,
        previousStatus, // drives the AFTER SIGNING flag when it was `signed`
      });
    }

    return {
      customerId: customer.Id,
      status,
      applied: false,
      reason: `aurora_says_${result.confirmedStatus}`,
      ...(previousStatus ? { previousStatus } : {}),
      ...(email ? { email } : {}),
    };
  }

  // Record the signed status alongside the pipeline position. Aurora's `signed`
  // translates to Status__c = Customer + Stage__c = Sold - Pending Review for EVERY
  // signed event — auto-created dealer records already got these at insert, and a
  // pre-existing matched customer gets them here, so the two paths agree. Harmon's
  // Salesforce alerts trigger off that Stage, which makes this write the actual
  // notification mechanism (the email channel is deliberately unconfigured).
  //
  // Separate PATCH from the business fields so a describe-dropped tracking field
  // can't take the mapped financing/design values down with it.
  const signedPipeline = buildSignedPipelineFields(schema);
  if (signedPipeline.warnings.length > 0) {
    result.warnings.push(...signedPipeline.warnings);
  }
  const trackingFields = filterToExisting(
    {
      [F_AGREEMENT_ID]: evt.agreement_id,
      [F_AGREEMENT_STATUS]: "signed",
      [F_AGREEMENT_STATUS_AT]: evt.received_at,
      ...signedPipeline.fields,
    },
    schema
  ).fields;
  if (Object.keys(trackingFields).length > 0) {
    await sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, trackingFields);
  }

  // d) Notify — best-effort, never blocks or undoes the write-back above.
  const email = await sendSignedNotification({
    customer,
    event: evt,
    design: result.design,
    financing: result.financing,
    proposal: result.proposal,
    fields: result.fields,
    pdfKey: result.pdfKey,
    warnings: result.warnings,
  });

  // Stamp the marker ONLY on a real send, so a failed email is retried by the next
  // delivery rather than being lost (same contract as the design-request email).
  if (email.sent && schema.has(F_SIGNED_EMAIL_SENT)) {
    try {
      await sfUpdateRecord(CUSTOMER_SF_OBJECT, customer.Id, {
        [F_SIGNED_EMAIL_SENT]: new Date().toISOString(),
      });
    } catch (e) {
      console.error(
        `aurora-inbound: could not stamp ${F_SIGNED_EMAIL_SENT} for ${customer.Id}: ${e?.message || e}`
      );
    }
  }

  return {
    customerId: customer.Id,
    status,
    applied: true,
    pdfKey: result.pdfKey,
    fieldsWritten: Object.keys(result.fields).length,
    warnings: result.warnings,
    email,
    ...(autoCreate
      ? { autoCreated: true, dealerName: autoCreate.dealerName }
      : {}),
    ...(repaired ? { repairedLink: true } : {}),
  };
}

// --- handler ----------------------------------------------------------------
export const handler = async (event) => {
  const records = parseSqsRecords(event);
  const batchItemFailures = [];

  for (const rec of records) {
    if (!rec.body || typeof rec.body !== "object") {
      // Unparseable message: retrying can't fix the bytes. Report it so it
      // redrives to the DLQ where it can be inspected.
      console.error(
        `aurora-inbound: PERMANENT malformed SQS message ${rec.messageId} — not JSON.`
      );
      batchItemFailures.push({ itemIdentifier: rec.messageId });
      continue;
    }

    const evt = rec.body;
    const label = `agreement=${evt.agreement_id} status=${evt.status} project=${evt.project_id}`;
    try {
      const result = await processEvent(evt);
      console.log(`aurora-inbound: processed ${label} -> ${JSON.stringify(result)}`);
    } catch (err) {
      const notProvisioned = err instanceof AuroraError && err.notProvisioned;
      const permanent = err?.permanent === true || notProvisioned;
      if (notProvisioned) {
        // Loud and unmistakable: this is an Aurora account-team problem.
        console.error(
          `aurora-inbound: PERMANENT AURORA_NOT_PROVISIONED (403) for ${label} — ` +
            `endpoint ${err.endpoint}. Our API key is not provisioned for it; ` +
            `retrying will never help. Contact Aurora's account team. ${err.message}`
        );
      } else if (permanent) {
        console.error(
          `aurora-inbound: PERMANENT ${err.code || "ERROR"} for ${label} — ${err.message}`
        );
      } else {
        console.error(
          `aurora-inbound: RETRYABLE failure for ${label} — ${err?.message || String(err)}`
        );
      }
      // Either way the message is not deleted: SQS redrives it, and the queue's
      // redrive policy lands it in the DLQ once maxReceiveCount is hit.
      batchItemFailures.push({ itemIdentifier: rec.messageId });
    }
  }

  // Partial batch response: only the failed messages are retried/dead-lettered.
  return { batchItemFailures };
};
