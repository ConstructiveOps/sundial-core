// Retell AI outbound-call client.
//
// One endpoint, one job: place a phone call with the Welcome Call agent and the
// customer's contract values pre-loaded as dynamic variables.
//
// Value-safety: the API key is never logged. The dynamic variables ARE customer PII
// (name, address, email, contract dollars) and are never logged either — only the
// resulting call_id and the record id.

export const RETELL_CREATE_CALL_URL = "https://api.retellai.com/v2/create-phone-call";
export const RETELL_GET_CALL_URL = "https://api.retellai.com/v2/get-call";

// Retell's create-call is a fast control-plane call (it returns as soon as the call
// is registered, not when it connects). If it hasn't answered in this long, the
// Lambda should give up rather than burn its own timeout budget.
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Fetch one completed call, including its post-call analysis.
 *
 * Used by the rep-form backfill: the orphan sweep hands us only `{call_id,
 * sf_record_id}`, so the analysis has to be re-read from the authority rather than
 * re-sent by Zapier. It is the same data the webhook saw, from the same source, which
 * is what lets both paths share one formatter and produce identical entries.
 *
 * Never throws — a backfill that cannot reach Retell must still leave the recording
 * attached, so the caller degrades to a short note instead of failing the match.
 *
 * @returns {Promise<{ ok: boolean, status: number, call: object|null, error: string|null }>}
 */
export async function getCall({ apiKey, callId }) {
  let resp;
  try {
    resp = await fetch(`${RETELL_GET_CALL_URL}/${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 0, call: null, error: e?.message || String(e) };
  }

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON — handled below */
  }

  if (!resp.ok) {
    const message =
      data?.error_message || data?.message || data?.error || text?.slice(0, 300) || "";
    return { ok: false, status: resp.status, call: null, error: message };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, status: resp.status, call: null, error: "empty response body" };
  }
  return { ok: true, status: resp.status, call: data, error: null };
}

/**
 * Place an outbound call.
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.fromNumber   - E.164, the Retell-owned number
 * @param {string} args.toNumber     - E.164
 * @param {string} args.agentId      - override_agent_id
 * @param {object} args.metadata     - echoed back on every webhook for this call
 * @param {Record<string,string>} args.dynamicVariables
 * @returns {Promise<{ ok: boolean, status: number, callId: string|null, error: string|null }>}
 */
export async function createPhoneCall({
  apiKey,
  fromNumber,
  toNumber,
  agentId,
  metadata,
  dynamicVariables,
}) {
  const body = {
    from_number: fromNumber,
    to_number: toNumber,
    override_agent_id: agentId,
    metadata,
    retell_llm_dynamic_variables: dynamicVariables,
  };

  let resp;
  try {
    resp = await fetch(RETELL_CREATE_CALL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // Network failure or timeout. We do NOT know whether Retell registered the call,
    // so the caller must not increment attempts or set "Calling" — leaving the record
    // eligible is the safe side of that ambiguity (a duplicate call is worse than a
    // retried one only if we'd already claimed success).
    return { ok: false, status: 0, callId: null, error: e?.message || String(e) };
  }

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — handled below */
  }

  if (!resp.ok) {
    // Retell's error bodies are business-level ("invalid to_number", "agent not
    // found") and safe to surface into the Salesforce log for a human.
    const message =
      data?.error_message || data?.message || data?.error || text?.slice(0, 300) || "";
    return { ok: false, status: resp.status, callId: null, error: message };
  }

  // Documented success is 201. Any other 2xx is accepted too — a stricter check would
  // fail a call that Retell actually placed, which is the worse error.
  const callId = data?.call_id ?? data?.callId ?? null;
  if (!callId) {
    return {
      ok: false,
      status: resp.status,
      callId: null,
      error: `Retell returned ${resp.status} with no call_id`,
    };
  }
  return { ok: true, status: resp.status, callId, error: null };
}
