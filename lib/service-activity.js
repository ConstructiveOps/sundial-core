// lib/service-activity.js — the Service module's activity tracker (D-072 amendment 2,
// 2026-09-11; docs/service-data-model.md §11).
//
// WHAT IT IS. One append-only Supabase table, `sundial_service_activity`, with a row per
// thing that happened to a job or its estimate: a field changed, a line was added /
// edited / removed, an estimate or invoice went out, a customer approved, a job was
// created from an estimate, a price-book item changed. Each row carries the EVENT, the
// ACTOR (Sundial user id + display name), a TIMESTAMP, and a small JSON `details`
// object (which fields, old → new values, version numbers, line ids).
//
// WHY SUPABASE AND NOT A SALESFORCE FIELD OR OBJECT. CLAUDE.md puts audit logs in the
// per-client Supabase project on purpose: unbounded rows, no Salesforce API cost per
// event, queryable by job/estimate/actor/date, and Supabase Realtime can push new rows
// to an open job page. A LongTextArea log (the Clock_Intervals pattern) caps at 131 KB
// and cannot be queried; a Salesforce object would burn an API call per event on a
// module whose whole point is to keep API consumption down.
//
// WHO WRITES. Two Lambdas: sundial-service-estimate (every route it owns) and
// sundial-sf-update (generic PATCH/POST on the service object keys, so a field edited
// from the job's detail page is tracked too). Both go through `recordActivity`, which is
// BEST-EFFORT by the standing rule — the Salesforce write has already succeeded and a
// logging failure must never turn it into an error for the user. Failures are logged
// with the full entry so nothing is silently lost.
//
// WHAT IT MISSES, honestly: edits made outside Sundial (a Salesforce Flow, Tim in the
// Salesforce UI, a data fix script). If that matters later, Salesforce Field History
// Tracking on the job (20 fields) is the backstop — not built here.
//
// ROLL-UP RULE. Rows are keyed by BOTH `job_sf_id` and `estimate_sf_id`. An estimate
// that pre-dates its job logs with `job_sf_id = null`; when Create Job runs,
// `linkEstimateActivityToJob` stamps those rows with the new job id so the job's feed
// shows its whole history from the first quote onward.

export const ACTIVITY_TABLE = "sundial_service_activity";

/** Event vocabulary. Keep additions here so the portal can render each one. */
export const EVENTS = Object.freeze({
  ESTIMATE_CREATED: "estimate_created",
  ESTIMATE_UPDATED: "estimate_updated",
  ESTIMATE_SENT: "estimate_sent",
  ESTIMATE_APPROVED: "estimate_approved",
  ESTIMATE_DECLINED: "estimate_declined",
  TEMPLATE_APPLIED: "template_applied",
  LINE_ADDED: "line_added",
  LINE_UPDATED: "line_updated",
  LINE_REMOVED: "line_removed",
  JOB_CREATED: "job_created",
  JOB_UPDATED: "job_updated",
  CUSTOMER_CREATED: "customer_created",
  CUSTOMER_TAGGED: "customer_tagged",
  INVOICE_SENT: "invoice_sent",
  INVOICE_ISSUED: "invoice_issued",
  PAYMENT_RECORDED: "payment_recorded",
  SERVICE_CALL_CREATED: "service_call_created", // dispatch board / job page: a tech scheduled onto a job
  SERVICE_CALL_UPDATED: "service_call_updated",
  SERVICE_CALL_CANCELLED: "service_call_cancelled",
  FIELD_UPDATED: "field_updated", // generic PATCH via sundial-sf-update
  RECORD_CREATED: "record_created", // generic POST via sundial-sf-update
  ITEM_CREATED: "item_created",
  ITEM_UPDATED: "item_updated",
  ITEM_NEW_VERSION: "item_new_version",
  ITEM_DEACTIVATED: "item_deactivated",
});

/** Object-key → which SF field on that record names its job / estimate (for sf-update). */
export const SERVICE_ACTIVITY_KEYS = Object.freeze({
  job: { recordType: "job", jobField: "Id", estimateField: "Estimate__c", event: EVENTS.JOB_UPDATED },
  estimate: { recordType: "estimate", jobField: "Service_Job__c", estimateField: "Id", event: EVENTS.ESTIMATE_UPDATED },
  servicecall: { recordType: "servicecall", jobField: "Sundial_Service_Job__c", estimateField: null, event: EVENTS.SERVICE_CALL_UPDATED },
  serviceline: { recordType: "serviceline", jobField: "Estimate__r.Service_Job__c", estimateField: "Estimate__c", event: EVENTS.LINE_UPDATED },
  serviceinvoice: { recordType: "serviceinvoice", jobField: "Service_Job__c", estimateField: null, event: EVENTS.FIELD_UPDATED },
  servicepayment: { recordType: "servicepayment", jobField: "Service_Job__c", estimateField: null, event: EVENTS.FIELD_UPDATED },
  pricebookitem: { recordType: "pricebookitem", jobField: null, estimateField: null, event: EVENTS.ITEM_UPDATED },
});

/** Compact "what changed" map: { field: { from, to } } for the fields that actually moved. */
export function diffFields(before = {}, after = {}) {
  const out = {};
  for (const [k, to] of Object.entries(after || {})) {
    const from = before ? before[k] : undefined;
    const same =
      (from === null || from === undefined || from === "") && (to === null || to === undefined || to === "")
        ? true
        : String(from) === String(to);
    if (!same) out[k] = { from: from === undefined ? null : from, to: to === undefined ? null : to };
  }
  return out;
}

/**
 * Shape one row. Everything optional except tenantId + event; unknown keys ignored so
 * a caller cannot smuggle columns. `details` is stored as JSON.
 */
export function buildActivityRow({
  tenantId, tenantSlug = null, event, recordType = null, recordSfId = null,
  jobSfId = null, estimateSfId = null, actor = null, details = null, at = null,
}) {
  if (!tenantId || !event) return null;
  return {
    client_sf_id: tenantId,
    tenant_id: tenantSlug,
    event,
    record_type: recordType,
    record_sf_id: recordSfId,
    job_sf_id: jobSfId,
    estimate_sf_id: estimateSfId,
    actor_user_sf_id: actor?.id ?? null,
    actor_name: actor?.name ?? null,
    details: details ?? {},
    at: at ?? new Date().toISOString(),
  };
}

/**
 * Insert one activity row. BEST-EFFORT: never throws. Returns true when the row landed.
 * `getSupabaseClient` is injected so both Lambdas (and tests) share this code.
 */
export async function recordActivity(getSupabaseClient, entry) {
  const row = buildActivityRow(entry);
  if (!row) return false;
  try {
    const supabase = await getSupabaseClient();
    const { error } = await supabase.from(ACTIVITY_TABLE).insert(row);
    if (error) {
      console.error("service-activity insert error:", error.message, JSON.stringify(row));
      return false;
    }
    return true;
  } catch (e) {
    console.error("service-activity insert threw:", e?.message || String(e), JSON.stringify(row));
    return false;
  }
}

/**
 * When an estimate gets its job, stamp the estimate's earlier rows with the job id so the
 * job feed starts at the first quote. Best-effort, tenant-scoped.
 */
export async function linkEstimateActivityToJob(getSupabaseClient, { tenantId, estimateSfId, jobSfId }) {
  if (!tenantId || !estimateSfId || !jobSfId) return false;
  try {
    const supabase = await getSupabaseClient();
    const { error } = await supabase
      .from(ACTIVITY_TABLE)
      .update({ job_sf_id: jobSfId })
      .eq("client_sf_id", tenantId)
      .eq("estimate_sf_id", estimateSfId)
      .is("job_sf_id", null);
    if (error) {
      console.error("service-activity link error:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("service-activity link threw:", e?.message || String(e));
    return false;
  }
}

/**
 * Read a feed, newest first, tenant-scoped. `by` is { jobSfId } or { estimateSfId }.
 * Returns { rows, error }. Not best-effort — a read that fails should say so.
 */
export async function listActivity(getSupabaseClient, { tenantId, jobSfId = null, estimateSfId = null, limit = 200, before = null }) {
  const supabase = await getSupabaseClient();
  let q = supabase.from(ACTIVITY_TABLE).select("*").eq("client_sf_id", tenantId);
  if (jobSfId) q = q.eq("job_sf_id", jobSfId);
  else if (estimateSfId) q = q.eq("estimate_sf_id", estimateSfId);
  else return { rows: [], error: "jobSfId or estimateSfId required" };
  if (before) q = q.lt("at", before);
  const { data, error } = await q.order("at", { ascending: false }).limit(Math.min(Math.max(Number(limit) || 200, 1), 500));
  return { rows: data ?? [], error: error?.message ?? null };
}
