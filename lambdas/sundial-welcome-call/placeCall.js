// ENTRY POINT 1 — place a Welcome Call.
//
// Reached from the `Sundial_Welcome_Call_Request__e` platform event, relayed to this
// Lambda through Salesforce Event Relay -> Amazon EventBridge. The event carries one
// field, Customer_Id__c. Everything else is read from Salesforce.
//
// THE READ IS ALWAYS FRESH FROM SALESFORCE — never the cache. These values are about
// to be spoken to a customer as the terms of a contract they signed. The cache has a
// documented TTL and a documented deletion blind spot; a stale monthly payment read
// aloud on a recorded call is a customer-trust and compliance problem, not a
// rendering glitch. This is exactly the "always-fresh-from-Salesforce operations"
// class in docs/caching-architecture.md.
//
// THE ELIGIBILITY GUARD IS THE SAFETY INTERLOCK. Everything it checks is a reason
// dialing would be WRONG, not merely unhelpful:
//   - a status of Calling means a call is already in flight (double-dial)
//   - a terminal status means the outcome is already recorded (re-litigating a
//     Refused customer is a complaint)
//   - attempts >= 5 is the harassment ceiling
//   - an unparseable phone number means we'd dial a stranger
//   - outside 08:00-20:00 Phoenix is a TCPA-style calling-hours violation
//   - an unmappable financing partner means we cannot say WHICH terms are real
// A skip is a success. It logs and returns; it never throws and never retries.

import { sfQuery, soqlEscapeString, describeObject } from "../../lib/salesforce.js";
import { resolveCustomerFields } from "./fields.js";
import {
  MAX_ATTEMPTS,
  TERMINAL_OR_IN_FLIGHT_STATUSES,
  buildDynamicVariables,
  isWithinCallWindow,
  mapFinanceSource,
  phoenixHour,
  phoenixStamp,
  toE164US,
} from "./format.js";
import { createPhoneCall } from "./retell.js";
import { applyWelcomeCallUpdate, prependLogEntry, CUSTOMER_SF_OBJECT } from "./writeback.js";
import { getConfig } from "./config.js";

/** Salesforce id shape (15 or 18 char, alphanumeric). */
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/**
 * Pull Customer_Id__c out of whatever shape the relay delivered.
 *
 * Both relay shapes are handled for the same reason sundial-budget handles both: the
 * EventBridge rule is Tim's to configure, and an SQS-wrapped variant must not require
 * a code change. See docs/integrations/budget-recalc-relay.md.
 *
 *   EventBridge (Event Relay):  { detail: { payload: { Customer_Id__c } } }
 *   SQS-wrapped:                { Records: [{ body: "<json>" }] }
 *   Direct invoke (manual test): { Customer_Id__c } or { customerId }
 *
 * @returns {string[]} customer ids, in delivery order, de-duplicated
 */
export function extractCustomerIds(event) {
  const ids = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim() !== "") ids.push(v.trim());
  };
  const fromPayload = (p) => {
    if (!p || typeof p !== "object") return;
    push(p.Customer_Id__c ?? p.customer_id ?? p.customerId);
  };

  if (Array.isArray(event?.Records)) {
    for (const r of event.Records) {
      let parsed = {};
      try {
        parsed = JSON.parse(r?.body);
      } catch {
        continue; // non-JSON body -> nothing to act on
      }
      fromPayload(parsed?.detail?.payload || parsed?.payload || parsed);
    }
  } else if (event?.detail) {
    fromPayload(event.detail.payload || event.detail);
  } else {
    fromPayload(event);
  }

  return [...new Set(ids)];
}

/**
 * Read one customer FRESH from Salesforce, describe-guarded.
 * Not tenant-filtered: there is no caller here, and the record's OWN Client__c is
 * what scopes every write that follows (same model as sundial-aurora-inbound).
 */
async function readCustomerFresh(recordId, schema) {
  const soql =
    `SELECT ${schema.selectFields.join(", ")} FROM ${CUSTOMER_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  return rows?.[0] ?? null;
}

/**
 * Write a skip reason into Welcome_Call_Log__c without touching status or attempts.
 * Used only where a human has to change DATA for the call to ever happen — an
 * unmappable financing partner. The other skips are transient or self-evident from
 * the record itself and would just churn the log.
 */
async function logSkipToSalesforce({ record, schema, tenantId, line }) {
  const logApi = schema.apiName("welcomeCallLog");
  if (!logApi) return; // no log field in this org — CloudWatch is the only record
  const next = prependLogEntry(record[logApi], line, schema.fieldLength("welcomeCallLog"));
  try {
    await applyWelcomeCallUpdate({
      recordId: record.Id,
      tenantId,
      sfFields: { [logApi]: next },
      cacheValues: { welcome_call_log: next },
      broadcastPayload: { reason: "skipped" },
    });
  } catch (e) {
    // A failed skip-note must not turn a skip into a retry loop.
    console.error(
      `welcome-call: could not write skip note for ${record.Id}:`,
      e?.message || String(e)
    );
  }
}

/**
 * Evaluate the eligibility guard.
 * @returns {{ eligible: true, phone: string, finance: object, attempts: number }
 *          |{ eligible: false, reason: string, detail?: string, writeLogLine?: string }}
 */
export function evaluateEligibility(get, now = new Date()) {
  const status = get("welcomeCallStatus");
  if (status && TERMINAL_OR_IN_FLIGHT_STATUSES.has(String(status).trim())) {
    return { eligible: false, reason: "status", detail: String(status).trim() };
  }

  const attempts = Number(get("welcomeCallAttempts")) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    return { eligible: false, reason: "max_attempts", detail: `${attempts}` };
  }

  const phone = toE164US(get("phone"));
  if (!phone) {
    return { eligible: false, reason: "no_phone" };
  }

  if (!isWithinCallWindow(now)) {
    return {
      eligible: false,
      reason: "outside_calling_window",
      detail: `${String(phoenixHour(now)).padStart(2, "0")}:00 America/Phoenix`,
    };
  }

  const partner = get("financingPartner");
  const finance = mapFinanceSource(partner);
  if (!finance) {
    const shown = partner == null || String(partner).trim() === "" ? "(blank)" : String(partner).trim();
    return {
      eligible: false,
      reason: "unmappable_financing_partner",
      detail: shown,
      // This one goes into Salesforce: it is a data-quality task, and nobody is
      // watching CloudWatch for it.
      writeLogLine: `unmappable financing partner: ${shown}`,
    };
  }

  return { eligible: true, phone, finance, attempts };
}

/**
 * Place (or deliberately skip) the Welcome Call for one customer.
 * Resolves to a result object; only genuinely unexpected failures throw.
 */
export async function placeWelcomeCall(recordId, { now = new Date() } = {}) {
  if (!SF_ID_RE.test(String(recordId || ""))) {
    console.warn(`welcome-call: ignoring malformed customer id "${recordId}"`);
    return { recordId, status: "invalid_id" };
  }

  const cfg = await getConfig();
  const missingCfg = [
    !cfg.retellApiKey && "RETELL_API_KEY",
    !cfg.retellFromNumber && "RETELL_FROM_NUMBER",
    !cfg.retellAgentId && "RETELL_AGENT_ID",
  ].filter(Boolean);
  if (missingCfg.length) {
    // Throw: this is a deployment fault, not a per-record decision, and it should be
    // loud (and retryable) rather than quietly recorded as a skip on the customer.
    throw new Error(`welcome-call not configured — missing ${missingCfg.join(", ")}`);
  }

  const describe = await describeObject(CUSTOMER_SF_OBJECT);
  const schema = resolveCustomerFields(describe);
  if (schema.missingRequired.length) {
    throw new Error(
      `Sundial_Customer__c is missing required Welcome Call field(s): ` +
        `${schema.missingRequired.join(", ")} — refusing to place calls.`
    );
  }
  if (schema.missingLogical.length) {
    // Degrade, don't fail: these become "not provided" in the agent's script.
    console.warn(
      `welcome-call: fields absent from the org (rendered as "not provided"): ${schema.missingLogical.join(", ")}`
    );
  }

  const record = await readCustomerFresh(recordId, schema);
  if (!record) {
    console.warn(`welcome-call: no Sundial_Customer__c ${recordId} — nothing to call.`);
    return { recordId, status: "record_not_found" };
  }

  const get = schema.reader(record);
  const tenantId = get("client") ?? null;

  const verdict = evaluateEligibility(get, now);
  if (!verdict.eligible) {
    console.log(
      `welcome-call SKIP ${recordId}: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`
    );
    if (verdict.writeLogLine) {
      await logSkipToSalesforce({
        record,
        schema,
        tenantId,
        line: `${phoenixStamp(now)} · Skipped · ${verdict.writeLogLine}`,
      });
    }
    return { recordId, status: "skipped", reason: verdict.reason, detail: verdict.detail };
  }

  const attemptNo = verdict.attempts + 1;
  const dynamicVariables = buildDynamicVariables(get, verdict.finance);

  const call = await createPhoneCall({
    apiKey: cfg.retellApiKey,
    fromNumber: cfg.retellFromNumber,
    toNumber: verdict.phone,
    agentId: cfg.retellAgentId,
    metadata: {
      source: "sundial",
      sf_record_id: record.Id,
      tenant: tenantId,
      attempt_no: attemptNo,
    },
    dynamicVariables,
  });

  if (!call.ok) {
    // No status change and NO attempt increment: we never established that a call was
    // placed, so burning one of five attempts on our own outage would be wrong.
    // Throwing makes the relay retry.
    const err = new Error(
      `Retell create-phone-call failed for ${recordId} (HTTP ${call.status}): ${call.error}`
    );
    err.retellStatus = call.status;
    throw err;
  }

  const statusApi = schema.apiName("welcomeCallStatus");
  const attemptsApi = schema.apiName("welcomeCallAttempts");
  const logApi = schema.apiName("welcomeCallLog");

  const line =
    `${phoenixStamp(now)} · Attempt ${attemptNo} · Call placed · call_id=${call.callId}`;
  const nextLog = prependLogEntry(record[logApi], line, schema.fieldLength("welcomeCallLog"));

  const sfFields = {
    [statusApi]: "Calling",
    [attemptsApi]: attemptNo,
    [logApi]: nextLog,
  };

  // If this write fails the call is ALREADY DIALING, so the throw is not a rollback —
  // it is a request for the relay to retry the bookkeeping. The idempotency guard on
  // the webhook side keys off call_id, and a retry re-reads the record, sees no
  // "Calling" status, and rewrites the same three fields. The one real cost of a
  // retry is a second dial, which the "Calling" status is there to prevent — hence
  // the loud error.
  const applied = await applyWelcomeCallUpdate({
    recordId: record.Id,
    tenantId,
    sfFields,
    cacheValues: {
      welcome_call_status: "Calling",
      welcome_call_attempts: attemptNo,
      welcome_call_log: nextLog,
    },
    broadcastPayload: { call_id: call.callId, attempt_no: attemptNo },
  });

  console.log(
    `welcome-call PLACED ${recordId}: attempt ${attemptNo}, call_id=${call.callId}, ` +
      `finance_source=${verdict.finance.financeSource}, cache=${applied.cache}, realtime=${applied.realtime}`
  );

  return {
    recordId,
    status: "placed",
    callId: call.callId,
    attemptNo,
    financeSource: verdict.finance.financeSource,
  };
}
