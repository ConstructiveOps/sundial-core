// Supabase Realtime broadcast for Sundial Lambda functions.
//
// The write path in docs/caching-architecture.md ends with "broadcast an
// invalidation via Supabase Realtime so other connected clients refresh". This is
// the sender side of that.
//
// WHY HTTP AND NOT THE supabase-js CHANNEL API: a channel broadcast opens a
// WebSocket, subscribes, sends, and must then be torn down. In Lambda that means a
// connection whose lifetime is tied to a container that may freeze mid-handshake,
// and a frozen socket is a silent dropped message. Supabase exposes a stateless
// HTTP endpoint for exactly this case (`POST /realtime/v1/api/broadcast`), which is
// one request/response with no connection to manage. Same delivery to subscribers.
//
// EVERY CALL IS BEST-EFFORT. A broadcast is a latency optimization for sessions
// that already have the record on screen — the cache and Salesforce are the
// authority. A failure here must NEVER fail the write that produced it, so this
// module resolves to { ok:false, reason } instead of throwing.
//
// Value-safety: never logs the service-role key.

import { getSupabaseConfig } from "./supabase.js";

// How long we let a broadcast hold up the caller before giving up on it. The write
// it accompanies has already been committed to Salesforce at this point, so waiting
// longer buys nothing.
const BROADCAST_TIMEOUT_MS = 3000;

/**
 * Build the channel name for one record, per the convention in
 * docs/caching-architecture.md: `tenant:{tenant_id}:{object}:{sf_id}`.
 *
 * @param {string} tenantId - the Salesforce Client record id (the isolation key)
 * @param {string} objectKey - snake_case object name, e.g. "sundial_customer"
 * @param {string} sfId - the record id, or "list" for a collection channel
 */
export function recordChannel(tenantId, objectKey, sfId) {
  return `tenant:${tenantId}:${objectKey}:${sfId}`;
}

/**
 * Broadcast one message on a Realtime channel over HTTP.
 *
 * The payload carries the changed fields (not just an invalidation flag) so a
 * subscribed client can apply it to local state without a round trip back to
 * Lambda — see the "Real-Time Updates in the Portal" section of the caching doc.
 *
 * @param {string} channel - e.g. the result of recordChannel(...)
 * @param {string} eventName - e.g. "record_updated"
 * @param {object} payload - JSON-serializable message body
 * @returns {Promise<{ ok: boolean, reason?: string, status?: number }>} never throws
 */
export async function broadcast(channel, eventName, payload) {
  let cfg;
  try {
    cfg = await getSupabaseConfig();
  } catch (e) {
    return { ok: false, reason: `supabase config unavailable: ${e?.message || e}` };
  }

  const url = `${String(cfg.url).replace(/\/+$/, "")}/realtime/v1/api/broadcast`;
  const body = JSON.stringify({
    messages: [{ topic: channel, event: eventName, payload: payload ?? {} }],
  });

  // AbortSignal.timeout is available on the Node 22 Lambda runtime.
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, reason: `broadcast HTTP ${resp.status}` };
    }
    return { ok: true, status: resp.status };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}
