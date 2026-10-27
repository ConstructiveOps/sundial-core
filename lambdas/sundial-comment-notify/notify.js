// The @-mention notification flow.
//
// Called once per `comment_mentions` row, by the AFTER INSERT trigger in
// sql/sundial_comment_mention_notify.sql (via pg_net).
//
// EVERY SKIP IS A SUCCESS. Alerts off, self-mention, no email address, SES not wired —
// all of these are correct outcomes, not failures, and every one returns 200 with a
// `reason`. pg_net does not retry a 200, which is exactly what we want: re-delivering a
// mention whose recipient has alerts off would achieve nothing but log noise. Only a
// genuine fault (a missing row, a send that errored) returns non-2xx.
//
// IDEMPOTENCY is `comment_mentions.notified_at`, stamped ONLY after a successful send.
// pg_net can redeliver and a human can replay; neither should double-email. Nothing
// stamps it on a skip, so a recipient who turns alerts back on, or an SES that comes
// online later, can still be reached by a replay.
//
// Value-safety: NEVER logs the comment body or a full recipient address (the rule in
// lib/email.js). Identifiers — mention id, comment id, the recipient's auth uuid — are
// logged, because without them nothing here is diagnosable.

import { getSupabaseClient } from "../../lib/supabase.js";
import { isEmailConfigured, sendEmail } from "../../lib/email.js";
import { DEALER_SCOPES, buildMentionEmail, dealerRecordLink, recordLabel, recordLink } from "./content.js";
import { CATEGORIES, createNotifier } from "../../lib/notify.js";
import { isPrimaryTenant } from "../../lib/tenant-guard.js";
import { createTenantSettings } from "../../lib/tenant-settings.js";

// The bell + push side of a mention (D-074), built once per warm container. Injectable
// for tests through handleMention's third argument.
let defaultNotifier = null;
const notifierFor = (opts) => opts?.notifier ?? (defaultNotifier ??= createNotifier());
/** Test hook: swap the module-level notifier (index.js gives handleMention no deps). */
export function setDefaultNotifier(n) {
  defaultNotifier = n;
}

export const MENTIONS_TABLE = "comment_mentions";
export const COMMENTS_TABLE = "comments";
export const PREFERENCES_TABLE = "user_preferences";
export const PROFILES_TABLE = "profiles";

/**
 * Cache table + column candidates for a human record label, per object key.
 *
 * Best-effort and READ FROM THE CACHE, never Salesforce: a subject line is not worth a
 * Salesforce API call (docs/caching-architecture.md), and a stale customer name in an
 * email subject is harmless in a way a stale contract value is not. First non-empty
 * column wins; a miss falls back to "<object> <id>".
 */
const LABEL_SOURCES = {
  customer: { table: "sundial_customer_cache", columns: ["customer_name", "name"] },
  solar: {
    table: "sundial_solar_cache",
    columns: ["customer_name_at_creation", "project_name", "address_at_creation"],
    // The solar's customer: where a dealer / rep recipient is linked (D-086).
    customerColumn: "sundial_customer_sf_id",
  },
  roofing: {
    table: "sundial_roofing_cache",
    columns: ["customer_name_at_creation", "project_name", "address_at_creation"],
  },
  // Service job: "SVC-00012 · Ann Lee" would be ideal; the first non-empty column wins,
  // so the customer's name leads and the job number is the fallback.
  job: {
    table: "sundial_service_job_cache",
    columns: ["customer_name_at_creation", "name", "address_at_creation"],
  },
};

/** Skip/So-far results are shaped identically so the handler can just return them. */
const skip = (reason, extra = {}) => ({ status: 200, body: { sent: false, reason, ...extra } });

// Every cache table carries the record's tenant twice: `client_sf_id` (the tenant RECORD
// id, the isolation key) and `tenant_id` (the tenant SLUG). Reading them on the row the
// label already needs is how this Lambda learns a comment's tenant slug for free (D-078).
const TENANT_COLUMNS = ["client_sf_id", "tenant_id"];

/**
 * Look up the record's display name — and, from the same row, which tenant it belongs to.
 * Never throws — a label is a nicety.
 *
 * `expectedTenantId` is the comment's tenant (record id). When the cached row says it
 * belongs to a DIFFERENT tenant, nothing is returned: a comment can be written against
 * any record id string, and another tenant's customer name must never reach a subject
 * line. A row with no tenant recorded is used as before.
 *
 * @returns {Promise<{ name: string|null, tenantSlug: string|null, customerId: string|null }>}
 *   tenantSlug is set only when the row's `client_sf_id` EQUALS expectedTenantId.
 *   customerId is the record's customer: the id itself for a customer, the cached
 *   `sundial_customer_sf_id` for a solar (D-086), else null.
 */
export async function lookupRecord(supabase, objectKey, recordId, expectedTenantId = null) {
  const key = String(objectKey ?? "").trim().toLowerCase();
  const none = { name: null, tenantSlug: null, customerId: null };
  const source = LABEL_SOURCES[key];
  if (!source || !recordId) return none;
  const ownCustomer = key === "customer" ? recordId : null;
  const extra = source.customerColumn ? [source.customerColumn] : [];
  try {
    let { data, error } = await supabase
      .from(source.table)
      .select([...source.columns, ...extra, ...TENANT_COLUMNS].join(","))
      .eq("sf_id", recordId)
      .maybeSingle();
    if (error) {
      // The wider select must never cost the label: retry exactly the read this function
      // made before the tenant and customer columns were added.
      ({ data, error } = await supabase.from(source.table).select(source.columns.join(",")).eq("sf_id", recordId).maybeSingle());
    }
    if (error || !data) return { ...none, customerId: ownCustomer };
    const rowTenantId = typeof data.client_sf_id === "string" && data.client_sf_id.trim() !== "" ? data.client_sf_id.trim() : null;
    if (rowTenantId && expectedTenantId && rowTenantId !== expectedTenantId) return none;
    const sameTenant = rowTenantId != null && rowTenantId === expectedTenantId;
    const tenantSlug = sameTenant && typeof data.tenant_id === "string" && data.tenant_id.trim() !== "" ? data.tenant_id.trim() : null;
    const linked = source.customerColumn ? data[source.customerColumn] : null;
    const customerId = ownCustomer ?? (typeof linked === "string" && linked.trim() !== "" ? linked.trim() : null);
    for (const col of source.columns) {
      const v = data[col];
      if (typeof v === "string" && v.trim() !== "") return { name: v.trim(), tenantSlug, customerId };
    }
    return { name: null, tenantSlug, customerId };
  } catch {
    return { ...none, customerId: ownCustomer }; // a label is never worth failing a notification over
  }
}

/**
 * Look up a display name for the record. Never throws — a label is a nicety.
 * @returns {Promise<string|null>}
 */
export async function lookupRecordName(supabase, objectKey, recordId) {
  return (await lookupRecord(supabase, objectKey, recordId)).name;
}

// --- Which portal the email's link opens (D-078) -----------------------------------
//
// `cfg.portalBaseUrl` is one address per Lambda and it is the PRIMARY tenant's portal.
// A mention in any other tenant must link to THAT tenant's portal (`portalUrl` in its
// block of Secrets Manager `sundial/brand`, lib/tenant-settings.js) or carry no link.
//
// The comment only knows its tenant's RECORD ID; the rule is keyed by SLUG. The slug is
// learned, in this order, and remembered for the life of the warm container (a tenant's
// id and slug never change):
//   1. from the cached record row the label lookup already reads — no extra query;
//   2. else ONE small read of `sundial_user_cache` (any row of that tenant carries both).
// A tenant whose slug cannot be learned is treated as "not the primary tenant, no
// address": the email goes out without a link. It never borrows the primary's address.
const USER_CACHE_TABLE = "sundial_user_cache";
const tenantSlugById = new Map();
let tenantSettings = null;
/** Test hook: forget what this container has learned about tenants. */
export function clearTenantCache() {
  tenantSlugById.clear();
  tenantSettings = null;
}

async function tenantSlugFor(supabase, tenantId, hintSlug) {
  if (!tenantId) return null;
  if (hintSlug) tenantSlugById.set(tenantId, hintSlug);
  if (tenantSlugById.has(tenantId)) return tenantSlugById.get(tenantId);
  try {
    const { data, error } = await supabase.from(USER_CACHE_TABLE).select("tenant_id").eq("client_sf_id", tenantId).limit(1).maybeSingle();
    const slug = !error && typeof data?.tenant_id === "string" && data.tenant_id.trim() !== "" ? data.tenant_id.trim() : null;
    if (slug) tenantSlugById.set(tenantId, slug); // a miss is NOT remembered: the next mention tries again
    return slug;
  } catch {
    return null;
  }
}

/** The portal origin for this comment's tenant, or null when it has none configured. */
async function portalBaseFor(supabase, tenantId, hintSlug, cfg) {
  const slug = await tenantSlugFor(supabase, tenantId, hintSlug);
  if (isPrimaryTenant(slug)) return cfg.portalBaseUrl; // the primary tenant: the same address as always, no secret read
  if (!slug) return null;
  tenantSettings ??= createTenantSettings();
  return tenantSettings.portalUrlFor(slug, cfg.portalBaseUrl);
}

/**
 * Resolve the recipient's email from auth.users via the service role.
 *
 * auth.users is the AUTHORITATIVE store. `profiles.email` holds a copy, but it is only
 * populated once a user has hit /auth/me, so a freshly-invited user who was @-mentioned
 * before their first sign-in would silently get nothing.
 *
 * @returns {Promise<{ ok: true, email: string|null } | { ok: false, error: string }>}
 */
export async function lookupRecipientEmail(supabase, userId) {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) return { ok: false, error: error.message || String(error) };
    return { ok: true, email: data?.user?.email ?? null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Handle one mention.
 *
 * @param {{ mention_id?: string, comment_id?: string, mentioned_user_id?: string }} payload
 * @param {{ portalBaseUrl: string }} cfg
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleMention(payload, cfg, { now = new Date(), notifier = undefined } = {}) {
  const mentionId = str(payload?.mention_id);
  const commentIdIn = str(payload?.comment_id);
  const mentionedUserIdIn = str(payload?.mentioned_user_id);

  if (!mentionId && !(commentIdIn && mentionedUserIdIn)) {
    return {
      status: 400,
      body: {
        error: "missing_fields",
        code: "MISSING_FIELDS",
        message: "Provide mention_id, or both comment_id and mentioned_user_id.",
      },
    };
  }

  const supabase = await getSupabaseClient();

  // --- 1) The mention row --------------------------------------------------
  // Addressed by id when we have one. The (comment_id, mentioned_user_id) pair is the
  // fallback for a manual replay, where the id may not be to hand.
  let q = supabase
    .from(MENTIONS_TABLE)
    .select("id, comment_id, mentioned_user_id, notified_at")
    .limit(1);
  q = mentionId
    ? q.eq("id", mentionId)
    : q.eq("comment_id", commentIdIn).eq("mentioned_user_id", mentionedUserIdIn);

  const { data: mention, error: mentionErr } = await q.maybeSingle();
  if (mentionErr) {
    console.error("comment-notify: mention lookup failed:", mentionErr.message);
    return { status: 502, body: { error: "mention_lookup_failed", code: "DB_ERROR" } };
  }
  if (!mention) {
    // Not a skip: the trigger only fires for rows that exist, so this means the row was
    // deleted between commit and delivery, or somebody replayed a bad id. Worth seeing.
    console.warn(
      `comment-notify: no ${MENTIONS_TABLE} row for ${mentionId || `${commentIdIn}/${mentionedUserIdIn}`}`
    );
    return { status: 404, body: { error: "mention_not_found", code: "MENTION_NOT_FOUND" } };
  }

  // --- 2) Idempotency ------------------------------------------------------
  if (mention.notified_at) {
    console.log(
      `comment-notify: mention ${mention.id} already notified at ${mention.notified_at} — skipping.`
    );
    return skip("already_notified", { mentionId: mention.id });
  }

  // --- 3) The comment ------------------------------------------------------
  // `is_private` arrives with sql/sundial_access_p11_comment_privacy.sql (D-086). Until
  // that runs the column does not exist and NO comment can be private, so the read is
  // retried without it — a Lambda deployed first must not 502 every mention.
  const COMMENT_COLUMNS = "id, tenant_id, record_id, record_object, author_id, author_name, body, context";
  let { data: comment, error: commentErr } = await supabase
    .from(COMMENTS_TABLE)
    .select(`${COMMENT_COLUMNS}, is_private`)
    .eq("id", mention.comment_id)
    .maybeSingle();
  if (commentErr && /is_private/i.test(commentErr.message || "")) {
    ({ data: comment, error: commentErr } = await supabase
      .from(COMMENTS_TABLE)
      .select(COMMENT_COLUMNS)
      .eq("id", mention.comment_id)
      .maybeSingle());
  }
  if (commentErr) {
    console.error("comment-notify: comment lookup failed:", commentErr.message);
    return { status: 502, body: { error: "comment_lookup_failed", code: "DB_ERROR" } };
  }
  if (!comment) {
    console.warn(
      `comment-notify: mention ${mention.id} points at missing comment ${mention.comment_id}`
    );
    return { status: 404, body: { error: "comment_not_found", code: "COMMENT_NOT_FOUND" } };
  }

  // --- 4) Self-mention -----------------------------------------------------
  // People @-mention themselves constantly — to bookmark a thread, or by autocomplete
  // accident. Emailing someone their own words is pure noise.
  if (comment.author_id && comment.author_id === mention.mentioned_user_id) {
    console.log(`comment-notify: mention ${mention.id} is a self-mention — skipping.`);
    return skip("self_mention", { mentionId: mention.id });
  }

  // --- 5) Preferences — ABSENCE MEANS ALERTS ON ----------------------------
  // Most users will never have a row here. `maybeSingle()` gives null for that, and
  // null must read as enabled: nobody opts in to keep today's behaviour.
  const { data: prefs, error: prefsErr } = await supabase
    .from(PREFERENCES_TABLE)
    .select("comment_email_alerts")
    .eq("user_id", mention.mentioned_user_id)
    .maybeSingle();
  if (prefsErr) {
    // A preferences read that ERRORS is not the same as one that returns nothing. Fail
    // open (send) rather than swallowing a real alert on the strength of a transient
    // database blip — the cost of a stray email is far below the cost of a missed one.
    console.warn(
      `comment-notify: preferences lookup failed for ${mention.mentioned_user_id} (${prefsErr.message}) — defaulting to alerts ON.`
    );
  }
  // Email off is decided here but acted on AFTER the bell (step 8b): the in-app
  // notification has its own switch (notify_prefs.mention) and must not be silenced by
  // the email one.
  const emailOff = prefs?.comment_email_alerts === false;

  // --- 6) Tenant guard -----------------------------------------------------
  // Defence in depth. The mention was inserted by a browser under RLS, which already
  // scopes it — but this path EMAILS A COMMENT BODY, so a cross-tenant mention would be
  // a data leak that no one ever sees. Only skips when both tenants are known AND
  // differ; a missing profile (user has never hit /auth/me) must not block a real alert.
  // `access_scope` (server-owned, written by sundial-auth-proxy) decides the private-comment
  // skip in 6c and which portal the link opens in 8.
  const { data: profile } = await supabase
    .from(PROFILES_TABLE)
    .select("tenant_id, access_scope")
    .eq("id", mention.mentioned_user_id)
    .maybeSingle();
  const recipientScope = typeof profile?.access_scope === "string" ? profile.access_scope.trim().toLowerCase() : null;
  if (comment.tenant_id && profile?.tenant_id && comment.tenant_id !== profile.tenant_id) {
    console.warn(
      `comment-notify: REFUSING cross-tenant mention ${mention.id} — comment tenant ` +
        `${comment.tenant_id} vs recipient tenant ${profile.tenant_id}.`
    );
    return skip("cross_tenant", { mentionId: mention.id });
  }

  // --- 6b) Record-visibility re-check (access-model.md §3.7, D-064) --------
  // The mention row was written by a browser under RLS, and `mentions_insert_scoped`
  // (sql/sundial_access_p1b_comment_rls.sql) already refuses a mention of a user who
  // cannot see the record. THIS IS THE SECOND LOCK ON THE SAME DOOR, and it is here
  // rather than in the policy because this path is the one that actually MOVES the
  // data: it emails the comment BODY to an address the recipient controls. A policy
  // regression would be silent; an email is not recallable.
  //
  // FAILS OPEN ON AN ERROR, CLOSED ON A `false`. The distinction matters and is the
  // same one step 5 draws for preferences: a transient RPC fault is not evidence of
  // a scope violation, and the primary control (the insert policy) has already
  // passed by the time we are called. Only an explicit "no" stops the send.
  //
  // NOT STAMPED. Like every other skip, `notified_at` stays NULL, so if the record
  // is later reassigned TO this person a replay still reaches them.
  const { data: visible, error: visErr } = await supabase.rpc("record_visible_for", {
    p_profile_id: mention.mentioned_user_id,
    p_object: comment.record_object,
    p_id: comment.record_id,
  });
  if (visErr) {
    console.warn(
      `comment-notify: record_visible_for failed for mention ${mention.id} ` +
        `(${visErr.message}) — proceeding; the RLS insert policy is the primary control.`
    );
  } else if (visible === false) {
    console.warn(
      `comment-notify: REFUSING mention ${mention.id} — ${mention.mentioned_user_id} ` +
        `cannot see ${comment.record_object}/${comment.record_id}. Not stamped, so a ` +
        `replay will reach them if their access changes.`
    );
    return skip("record_not_visible", { mentionId: mention.id });
  }

  // --- 6c) A PRIVATE comment never reaches a dealer or a rep (D-086) ---------
  // The insert policy already refuses this mention (comment_readable_for). Same second
  // lock as 6b, and stricter, because a private body is exactly what must not leave:
  //   dealer / own / none  → skip;  tenant / tech → on;
  //   no profile scope (never signed in, or a pre-Phase-1 profile) → ask the database
  //   the policy's own question, and skip on a "no" OR an error — fail CLOSED here,
  //   unlike 6b, since the body is private by definition.
  // No email, no bell, no push. Not stamped, so a replay reaches them if the comment is
  // made public again.
  if (comment.is_private === true) {
    let allowed;
    if (recipientScope === "tenant" || recipientScope === "tech") allowed = true;
    else if (recipientScope) allowed = false;
    else {
      const { data: readable, error: readErr } = await supabase.rpc("comment_readable_for", {
        p_profile_id: mention.mentioned_user_id,
        p_object: comment.record_object,
        p_id: comment.record_id,
        p_is_private: true,
      });
      if (readErr) {
        console.warn(`comment-notify: comment_readable_for failed for mention ${mention.id} (${readErr.message}) — private comment, skipping.`);
      }
      allowed = !readErr && readable === true;
    }
    if (!allowed) {
      console.warn(
        `comment-notify: REFUSING mention ${mention.id} — comment ${comment.id} is private and ` +
          `${mention.mentioned_user_id} is ${recipientScope ?? "not known to be"} staff. Not stamped.`
      );
      return skip("private_comment", { mentionId: mention.id });
    }
  }

  // --- 7) Recipient address ------------------------------------------------
  const recipient = await lookupRecipientEmail(supabase, mention.mentioned_user_id);
  if (!recipient.ok) {
    console.error(
      `comment-notify: could not read auth user ${mention.mentioned_user_id}: ${recipient.error}`
    );
    return { status: 502, body: { error: "recipient_lookup_failed", code: "AUTH_LOOKUP_FAILED" } };
  }
  if (!recipient.email) {
    console.log(
      `comment-notify: auth user ${mention.mentioned_user_id} has no email address — skipping.`
    );
    return skip("no_recipient_email", { mentionId: mention.id });
  }

  // --- 8) Compose ----------------------------------------------------------
  // The link opens the COMMENT'S tenant's portal (D-078, portalBaseFor above). The
  // record row is read first because it is also where the tenant's slug comes from.
  const commentTenantId = comment.tenant_id ?? profile?.tenant_id ?? null;
  const record = await lookupRecord(supabase, comment.record_object, comment.record_id, commentTenantId);
  const portalBase = await portalBaseFor(supabase, commentTenantId, record.tenantSlug, cfg);
  // A dealer or rep opens their own portal's customer page, whatever page the comment
  // was written on (D-086); everyone else follows the comment's context.
  const toDealer = DEALER_SCOPES.has(recipientScope);
  const linkFor = (base) =>
    toDealer ? dealerRecordLink(base, record.customerId) : recordLink(base, comment.record_object, comment.record_id, comment.context);
  const link = linkFor(portalBase ?? "");
  const known = link.known;
  const url = portalBase ? link.url : null;
  if (!portalBase) {
    console.warn(
      `comment-notify: no portal address for the tenant of comment ${comment.id} ` +
        `(sundial/brand portalUrl) — the alert goes out without a link.`
    );
  }
  if (!known && toDealer) {
    console.warn(
      `comment-notify: no customer for ${comment.record_object}/${comment.record_id} on comment ` +
        `${comment.id} — linking the dealer-scope recipient to their customer list.`
    );
  } else if (!known) {
    // Loud, because it means a module shipped without an entry in RECORD_PATHS and
    // every alert for it is now pointing at the dashboard.
    console.warn(
      `comment-notify: unknown record_object "${comment.record_object}" on comment ` +
        `${comment.id} — linking to the dashboard. Add it to RECORD_PATHS in content.js.`
    );
  }
  const label = recordLabel(comment.record_object, comment.record_id, record.name);
  const mail = buildMentionEmail({
    authorName: comment.author_name,
    commentBody: comment.body,
    label,
    url,
  });

  // --- 8b) The bell + push (D-074) -----------------------------------------
  // Every check above (self-mention, tenant, visibility) has passed, so the recipient
  // may see this record. Keyed on the mention id: a pg_net redelivery rings nobody twice.
  // Best-effort — lib/notify.js never throws — and never stamps notified_at.
  await notifierFor({ notifier }).toProfile({
    tenantId: comment.tenant_id ?? profile?.tenant_id ?? null,
    profileId: mention.mentioned_user_id,
    category: CATEGORIES.MENTION,
    kind: "comment",
    title: `${comment.author_name || "Someone"} mentioned you on ${label}`,
    body: comment.body,
    url: linkFor("").url,
    recordType: comment.record_object,
    recordSfId: comment.record_id,
    dedupeKey: `mention:${mention.id}`,
    // A dealer or rep's phone opens the dealer shell (dealer module step 6).
    ...(toDealer ? { app: "dealer" } : {}),
  });

  if (emailOff) {
    console.log(
      `comment-notify: ${mention.mentioned_user_id} has comment_email_alerts off — bell only, no email.`
    );
    return skip("alerts_disabled", { mentionId: mention.id });
  }

  // --- 9) SES may not be wired yet -----------------------------------------
  // Checked here rather than at the top so the skip reasons above still get evaluated
  // and logged — this Lambda is useful as a dry run before SES lands. Mirrors the
  // Design Request behaviour: not configured is a degraded success, not a failure, so
  // the whole feature ships and deploys ahead of the SES env wiring.
  //
  // notified_at is NOT stamped, so every one of these is recoverable by replay once
  // EMAIL_FROM is set.
  if (!isEmailConfigured()) {
    console.log(
      `comment-notify: EMAIL_FROM not set — mention ${mention.id} composed but not sent.`
    );
    return skip("email_not_configured", { mentionId: mention.id, linkKnown: known });
  }

  // --- 10) Send, then stamp ------------------------------------------------
  const res = await sendEmail({ to: recipient.email, subject: mail.subject, text: mail.text, html: mail.html });
  if (!res.ok) {
    // Deliberately NOT stamped: a failed send must stay replayable. 502 so the failure
    // is visible in the pg_net response table rather than looking like a quiet skip.
    console.error(`comment-notify: send failed for mention ${mention.id}: ${res.error}`);
    return { status: 502, body: { sent: false, error: "send_failed", reason: res.error } };
  }

  const { error: stampErr } = await supabase
    .from(MENTIONS_TABLE)
    .update({ notified_at: now.toISOString() })
    .eq("id", mention.id);
  if (stampErr) {
    // The email HAS been delivered. Reporting failure would invite a replay and a
    // duplicate, so this is a 200 that names the risk instead.
    console.error(
      `comment-notify: sent mention ${mention.id} but could not stamp notified_at: ${stampErr.message}`
    );
  }

  console.log(
    `comment-notify: sent mention ${mention.id} to ${mention.mentioned_user_id} ` +
      `(comment ${comment.id}, ${comment.record_object}/${comment.record_id}, linkKnown=${known})`
  );
  return {
    status: 200,
    body: {
      sent: true,
      mentionId: mention.id,
      messageId: res.messageId ?? null,
      stamped: !stampErr,
      linkKnown: known,
    },
  };
}

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
