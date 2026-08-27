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
import { buildMentionEmail, recordLabel, recordLink } from "./content.js";

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
  },
  roofing: {
    table: "sundial_roofing_cache",
    columns: ["customer_name_at_creation", "project_name", "address_at_creation"],
  },
};

/** Skip/So-far results are shaped identically so the handler can just return them. */
const skip = (reason, extra = {}) => ({ status: 200, body: { sent: false, reason, ...extra } });

/**
 * Look up a display name for the record. Never throws — a label is a nicety.
 * @returns {Promise<string|null>}
 */
export async function lookupRecordName(supabase, objectKey, recordId) {
  const source = LABEL_SOURCES[String(objectKey ?? "").trim().toLowerCase()];
  if (!source || !recordId) return null;
  try {
    const { data, error } = await supabase
      .from(source.table)
      .select(source.columns.join(","))
      .eq("sf_id", recordId)
      .maybeSingle();
    if (error || !data) return null;
    for (const col of source.columns) {
      const v = data[col];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return null;
  } catch {
    return null; // a label is never worth failing a notification over
  }
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
export async function handleMention(payload, cfg, { now = new Date() } = {}) {
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
  const { data: comment, error: commentErr } = await supabase
    .from(COMMENTS_TABLE)
    .select("id, tenant_id, record_id, record_object, author_id, author_name, body")
    .eq("id", mention.comment_id)
    .maybeSingle();
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
  if (prefs?.comment_email_alerts === false) {
    console.log(
      `comment-notify: ${mention.mentioned_user_id} has comment_email_alerts off — skipping.`
    );
    return skip("alerts_disabled", { mentionId: mention.id });
  }

  // --- 6) Tenant guard -----------------------------------------------------
  // Defence in depth. The mention was inserted by a browser under RLS, which already
  // scopes it — but this path EMAILS A COMMENT BODY, so a cross-tenant mention would be
  // a data leak that no one ever sees. Only skips when both tenants are known AND
  // differ; a missing profile (user has never hit /auth/me) must not block a real alert.
  const { data: profile } = await supabase
    .from(PROFILES_TABLE)
    .select("tenant_id")
    .eq("id", mention.mentioned_user_id)
    .maybeSingle();
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
  const { url, known } = recordLink(cfg.portalBaseUrl, comment.record_object, comment.record_id);
  if (!known) {
    // Loud, because it means a module shipped without an entry in RECORD_PATHS and
    // every alert for it is now pointing at the dashboard.
    console.warn(
      `comment-notify: unknown record_object "${comment.record_object}" on comment ` +
        `${comment.id} — linking to the dashboard. Add it to RECORD_PATHS in content.js.`
    );
  }
  const recordName = await lookupRecordName(supabase, comment.record_object, comment.record_id);
  const label = recordLabel(comment.record_object, comment.record_id, recordName);
  const mail = buildMentionEmail({
    authorName: comment.author_name,
    commentBody: comment.body,
    label,
    url,
  });

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
