// sundial-notify / stage.js — POST /webhooks/stage-change: a deal moved, tell its dealer and rep
// (dealer module step 6, D-074 amendment 3, 2026-10-26).
//
// WHY A DATABASE TRIGGER CALLS THIS. Nothing in Sundial decides a stage change: a portal
// edit, Tim's Flows, Aurora, Zapier and an admin in Salesforce all move Stage__c, and the
// one place every one of them lands is the cache (the write-through, the read-time
// refresh, the 5-minute sync). So sql/sundial_stage_notify.sql puts a trigger on
// sundial_customer_cache / sundial_solar_cache that posts here through pg_net — the
// pattern sql/sundial_comment_mention_notify.sql uses for @-mentions — and this route
// turns the post into one notification per recipient through lib/notify.js.
//
// THE POST: { object: customer|solar, sf_id, client_sf_id, old_stage, new_stage, modstamp, op }
//   op = insert | update (insert only on solar: a new project, old_stage null).
//
// WHO IS TOLD. Dealers and reps ONLY — Harmon staff never hear about a stage from this:
//   - the rep: the profile whose sundial_user_id is the row's sales_rep_sf_id (for a solar,
//     the parent customer's rep when the solar has none), and only if that profile's scope
//     is own or dealer — an internal rep who is staff is staff;
//   - the dealer: every profile with access_scope = 'dealer' and the row's dealer_sf_id
//     (for a solar, the parent customer's dealer when the solar has none).
// Always inside the row's own tenant (profiles.tenant_id = the row's client_sf_id).
//
// TRUST. The shared secret (X-Sundial-Stage-Secret, constant time, FAIL CLOSED: no secret
// configured = every request refused) is the only gate. The stage values come from the
// post — they are what the trigger saw change, and the row may have moved again since —
// but WHO is told and the tenant come from the cache row as it is now. A post whose
// client_sf_id disagrees with the row's is refused.
//
// IDEMPOTENT by the notifier's dedupe key `stage:{object}:{sf_id}:{new_stage}:{modstamp}`:
// a pg_net redelivery or a hand replay rings nobody twice. Nothing is rate limited.
//
// EVERY SKIP IS A 200 (row gone, tenant mismatch, nobody to tell) — pg_net does not
// retry a 200, and retrying would change nothing. Only a bad secret (401) or body (400)
// is an error.
//
// Value-safety: never logs the secret, a customer name, or a notification title / body.

import { constantTimeEquals } from "../../lib/secure-compare.js";
import { customerDisplayName } from "../../lib/customer-name.js";
import { CATEGORIES } from "../../lib/notify.js";

export const STAGE_SECRET_HEADER = "x-sundial-stage-secret";
export const STAGE_SECRET_NAME = "sundial/stage-notify";
export const STAGE_PATH = /^(?:\/[^/]+)?\/webhooks\/stage-change\/?$/;
export const CACHE_TABLES = Object.freeze({ customer: "sundial_customer_cache", solar: "sundial_solar_cache" });
export const RECIPIENT_REP_SCOPES = Object.freeze(["own", "dealer"]);
const SECRET_TTL_MS = 5 * 60 * 1000;

const JSON_HEADERS = { "Content-Type": "application/json" };
const respond = (statusCode, body) => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) });

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Is this event the stage webhook? (Checked before the JWT path — Postgres has no JWT.) */
export function isStageWebhook(method, path) {
  return method === "POST" && STAGE_PATH.test(path || "");
}

/** The dedupe key: one notification per recipient per (record, stage reached, moment). */
export function stageDedupeKey({ object, sfId, newStage, modstamp }) {
  return `stage:${object}:${sfId}:${newStage ?? ""}:${modstamp ?? ""}`;
}

/** customer | solar | solar_created. */
export function stageKind(object, op, oldStage) {
  if (object !== "solar") return "customer";
  if (op === "insert" || (op == null && oldStage == null)) return "solar_created";
  return "solar";
}

/** A body decoded the way API Gateway may hand it over. */
function parseBody(event) {
  let raw = event?.body;
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (event?.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export function createStageHandler(d) {
  // The secret: Secrets Manager first (rotation without a redeploy), env var second —
  // the sundial-comment-notify precedence. A failed read is not cached.
  let secretCache = null; // { value, at }
  async function expectedSecret() {
    if (secretCache && Date.now() - secretCache.at < SECRET_TTL_MS) return secretCache.value;
    let value = null;
    try {
      const s = await d.getSecret(STAGE_SECRET_NAME);
      value = str(s?.secret ?? s?.stage_notify_secret ?? s?.stageNotifySecret);
      secretCache = { value, at: Date.now() };
    } catch (e) {
      console.warn(`stage-notify: ${STAGE_SECRET_NAME} unreadable (${e?.message || e}) — trying STAGE_NOTIFY_SECRET.`);
    }
    return value ?? str(d.env?.STAGE_NOTIFY_SECRET);
  }

  async function readRow(supabase, table, sfId) {
    const { data, error } = await supabase.from(table).select("*").eq("sf_id", sfId).maybeSingle();
    if (error) {
      console.error(`stage-notify: ${table} read failed:`, error.message);
      return null;
    }
    return data ?? null;
  }

  /** Profiles in the tenant: the rep (own / dealer scope only) + the dealer's people. */
  async function recipientsFor(supabase, tenantId, repSfId, dealerSfId) {
    const out = [];
    if (repSfId) {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, sundial_user_id, access_scope")
        .eq("tenant_id", tenantId)
        .eq("sundial_user_id", repSfId)
        .in("access_scope", [...RECIPIENT_REP_SCOPES]);
      if (error) console.error("stage-notify: rep profile lookup failed:", error.message);
      out.push(...(data || []));
    }
    if (dealerSfId) {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, sundial_user_id, access_scope")
        .eq("tenant_id", tenantId)
        .eq("access_scope", "dealer")
        .eq("dealer_sf_id", dealerSfId);
      if (error) console.error("stage-notify: dealer profiles lookup failed:", error.message);
      out.push(...(data || []));
    }
    const seen = new Set();
    return out.filter((p) => p?.id && !seen.has(p.id) && seen.add(p.id));
  }

  return async function stageChange(event) {
    const headers = {};
    for (const [k, v] of Object.entries(event?.headers || {})) headers[String(k).toLowerCase()] = v;

    // --- AUTH GATE: fail closed --------------------------------------------------
    const expected = await expectedSecret();
    if (!expected) {
      console.error(`stage-notify: no secret configured (${STAGE_SECRET_NAME} / STAGE_NOTIFY_SECRET) — rejecting.`);
      return respond(401, { error: "unauthorized" });
    }
    const provided = headers[STAGE_SECRET_HEADER];
    if (typeof provided !== "string" || provided.length === 0 || !constantTimeEquals(provided, expected)) {
      console.warn(`stage-notify rejected: missing or invalid ${STAGE_SECRET_HEADER}.`);
      return respond(401, { error: "unauthorized" });
    }

    const body = parseBody(event);
    const object = str(body?.object)?.toLowerCase() ?? null;
    const sfId = str(body?.sf_id);
    const clientSfId = str(body?.client_sf_id);
    if (!body || !CACHE_TABLES[object] || !sfId || !clientSfId) return respond(400, { error: "invalid_body", code: "INVALID_BODY" });
    const oldStage = str(body.old_stage);
    const newStage = str(body.new_stage);
    const op = str(body.op)?.toLowerCase() ?? null;
    const modstamp = str(body.modstamp);
    const skip = (reason) => (console.log(`stage-notify: ${object}/${sfId} skipped — ${reason}`), respond(200, { sent: false, reason }));

    const supabase = await d.getSupabaseClient();
    const row = await readRow(supabase, CACHE_TABLES[object], sfId);
    if (!row) return skip("record_not_found");
    if (row.client_sf_id !== clientSfId) return skip("tenant_mismatch");
    const tenantId = row.client_sf_id;

    // A solar is seen through its customer (D-086): the link, the name, and the rep /
    // dealer when the solar carries none of its own.
    let customer = object === "customer" ? row : null;
    const customerId = object === "customer" ? row.sf_id : str(row.sundial_customer_sf_id);
    if (object === "solar" && customerId) {
      const parent = await readRow(supabase, CACHE_TABLES.customer, customerId);
      customer = parent && parent.client_sf_id === tenantId ? parent : null;
    }
    const repSfId = str(row.sales_rep_sf_id) ?? str(customer?.sales_rep_sf_id);
    const dealerSfId = str(row.dealer_sf_id) ?? str(customer?.dealer_sf_id);

    const recipients = await recipientsFor(supabase, tenantId, repSfId, dealerSfId);
    if (!recipients.length) return skip("no_recipients");

    const kind = stageKind(object, op, oldStage);
    const name =
      customerDisplayName(customer) ?? customerDisplayName(row) ?? str(row.customer_name_at_creation) ?? str(row.project_name) ?? "A customer";
    // The raw picklist value — the client shows its label. A value off the journey
    // (lib/dealer-journey.js) is still a stage change and still notifies.
    const stageLabel = newStage ?? (kind === "solar_created" ? "New solar project" : "No stage");
    const bodyText = oldStage ? `Previously: ${oldStage}` : kind === "solar_created" ? "New solar project" : null;

    const r = await d.notifier.deliver({
      tenantId,
      recipients,
      category: CATEGORIES.STAGE,
      kind,
      title: `${name} → ${stageLabel}`,
      body: bodyText,
      url: customerId ? `/dealer/customers/${customerId}` : "/dealer/customers",
      recordType: "dealercustomer",
      recordSfId: customerId,
      dedupeKey: stageDedupeKey({ object, sfId, newStage, modstamp }),
      app: "dealer",
    });
    console.log(`stage-notify: ${object}/${sfId} ${kind} → ${recipients.length} recipient(s), ${r?.inserted ?? 0} new`);
    return respond(200, { sent: true, kind, recipients: recipients.length, ...r });
  };
}
