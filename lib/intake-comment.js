// lib/intake-comment.js — the server's own lines in a customer's comment feed (2026-10-22,
// Harmon; DECISIONS.md D-084).
//
// When a customer's intake answers change, or someone is put in Assigned To, ONE row lands in
// the Supabase `comments` table on that customer — written by the Lambda that made the
// Salesforce write, so it happens whatever screen did it (the customer page's edit engine
// through sundial-sf-update, the New Customer / Estimate / Job popups through
// sundial-service-estimate). The portal's feed already renders `comments`; these rows carry
// `kind = 'system'` so it can show them muted.
//
// System comments are not conversation:
//   - no @-mentions, so no comment_mentions row and nothing for sundial-comment-notify (its
//     trigger is on comment_mentions, never on comments — no change needed there);
//   - best-effort, AFTER the Salesforce write, never a reason to fail the user's save.
//
// The labels are the portal's (harmon-crm src/config/service-customer-config.ts
// INTAKE_FIELDS), mirrored here; lib/intake-comment.test.js pins the two copies together
// whenever the harmon-crm checkout sits next to this repo.

export const COMMENTS_TABLE = "comments";
export const SYSTEM_KIND = "system";
/** Columns a system line sets that a not-yet-migrated `comments` table may lack, in retry order. */
const OPTIONAL_COLUMNS = ["kind", "is_private"];
export const COMMENT_TIME_ZONE = "America/Phoenix";
export const COMMENT_ZONE_LABEL = "Arizona";
/** A free-text answer is cut to this many characters in the comment (the field keeps it all). */
export const MAX_VALUE_CHARS = 200;

/** The intake questions, in the popup's order, with the portal's labels. */
export const INTAKE_COMMENT_FIELDS = Object.freeze([
  { apiName: "System_Ownership__c", label: "Do you own or lease the system?" },
  { apiName: "Property_Type__c", label: "Is the property residential or commercial?" },
  { apiName: "Existing_Harmon_System__c", label: "Did Harmon install this system?" },
  { apiName: "Inverter_Manufacturer__c", label: "What brand is your solar inverter?" },
  { apiName: "Warranty_Notes__c", label: "Warranty notes" },
  { apiName: "Type_of_Service__c", label: "What type of work do you need done?" },
  { apiName: "Description__c", label: "Tell us more about your issue." },
  { apiName: "Next_Step__c", label: "What would you like to do next?" },
  { apiName: "Service_Club_Interest__c", label: "Are you interested in signing up for our active monitoring service? It's $9.99 per month or $99 per year." },
]);
export const INTAKE_API_NAMES = Object.freeze(INTAKE_COMMENT_FIELDS.map((f) => f.apiName));
export const ASSIGNED_TO_FIELD = "Assigned_To__c";

const norm = (v) => (v == null ? "" : String(v).trim());
const keyOf = (obj, name) => Object.keys(obj || {}).find((k) => k.toLowerCase() === name.toLowerCase());

/** "Oct 22, 2026 3:05 PM" in Arizona time. */
export function commentTime(at, timeZone = COMMENT_TIME_ZONE) {
  const d = at instanceof Date ? at : new Date(at);
  const date = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${date} ${time}`;
}

function shown(v) {
  const s = norm(v).replace(/\s+/g, " ");
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s;
}

/**
 * The intake fields that the write sets or changes: [{ apiName, label, from, to }].
 * `before` is the customer as it was (null / {} for a new customer); `written` is what was
 * written (any key casing). A field not in `written` is untouched; the same value is no change.
 */
export function changedIntakeFields(before, written) {
  const out = [];
  for (const f of INTAKE_COMMENT_FIELDS) {
    const k = keyOf(written, f.apiName);
    if (!k) continue;
    const from = norm(before?.[f.apiName]);
    const to = norm(written[k]);
    if (from === to) continue;
    out.push({ apiName: f.apiName, label: f.label, from: from || null, to: to || null });
  }
  return out;
}

/** "Intake updated by Beth Office on Oct 22, 2026 3:05 PM (Arizona): Q — A; Q — (cleared)" — or null when nothing changed. */
export function intakeCommentBody({ changes, actorName, at }) {
  if (!changes?.length) return null;
  const parts = changes.map((c) => `${c.label} — ${c.to ? shown(c.to) : "(cleared)"}`);
  return `Intake updated by ${actorName || "Sundial"} on ${commentTime(at)} (${COMMENT_ZONE_LABEL}): ${parts.join("; ")}`;
}

/** "Assigned to Paige Ng by Beth Office on Oct 22, 2026 3:05 PM (Arizona)", or "Unassigned by …". */
export function assignmentCommentBody({ assigneeName, actorName, at }) {
  const when = `on ${commentTime(at)} (${COMMENT_ZONE_LABEL})`;
  const by = `by ${actorName || "Sundial"}`;
  return assigneeName ? `Assigned to ${assigneeName} ${by} ${when}` : `Unassigned ${by} ${when}`;
}

/** Whether a write's Assigned To differs from what the customer had (undefined = not written). */
export function assignmentChanged(before, written) {
  const k = keyOf(written, ASSIGNED_TO_FIELD);
  if (!k) return false;
  return norm(written[k]) !== norm(before?.[ASSIGNED_TO_FIELD]);
}

/**
 * Insert one system comment on a customer. Best-effort: never throws, returns true when it
 * landed.
 *
 * System lines are PRIVATE (D-086): staff-only office bookkeeping, never shown to the
 * customer's dealer or rep. Two columns may not exist yet — `kind`
 * (sql/2026-10-22_job_report_dates.sql) and `is_private`
 * (sql/sundial_access_p11_comment_privacy.sql). An insert whose error names one is retried
 * without it, so the line still lands (unstyled / with no privacy flag, which before p11
 * is what every comment is).
 */
export async function insertSystemComment(getSupabaseClient, { tenantId, customerId, authorId = null, authorName = null, body, context = "service", at = null }) {
  if (!tenantId || !customerId || !body) return false;
  const row = {
    tenant_id: tenantId,
    record_object: "customer",
    record_id: customerId,
    author_id: authorId || null,
    author_name: authorName || "Sundial",
    body,
    context,
    kind: SYSTEM_KIND,
    is_private: true,
    ...(at ? { created_at: new Date(at).toISOString() } : {}),
  };
  try {
    const supabase = await getSupabaseClient();
    let attempt = row;
    let { error } = await supabase.from(COMMENTS_TABLE).insert(attempt);
    // At most one retry per optional column, each only when the error names it — in
    // whichever order the database reports them.
    for (let i = 0; error && i < OPTIONAL_COLUMNS.length; i += 1) {
      const col = OPTIONAL_COLUMNS.find((c) => c in attempt && new RegExp(c, "i").test(error.message || ""));
      if (!col) break;
      const { [col]: _dropped, ...without } = attempt;
      attempt = without;
      ({ error } = await supabase.from(COMMENTS_TABLE).insert(attempt));
    }
    if (error) {
      console.error("system comment insert error:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("system comment insert threw:", e?.message || String(e));
    return false;
  }
}

/**
 * The whole decision for one customer write: the intake comment and / or the assignment
 * comment. `loadUserName(id)` resolves the assignee's name (tenant-scoped by the caller).
 * Returns the number of comments written. Never throws.
 */
export async function commentOnCustomerWrite({ getSupabaseClient, loadUserName, tenantId, customerId, before, written, actor, at = new Date() }) {
  let n = 0;
  try {
    const intake = intakeCommentBody({ changes: changedIntakeFields(before, written), actorName: actor?.name, at });
    if (intake && (await insertSystemComment(getSupabaseClient, { tenantId, customerId, authorId: actor?.profileId, authorName: actor?.name, body: intake, at }))) n += 1;
    if (assignmentChanged(before, written)) {
      const id = norm(written[keyOf(written, ASSIGNED_TO_FIELD)]);
      let assigneeName = null;
      if (id) {
        try {
          assigneeName = (await loadUserName(id)) || "someone";
        } catch {
          assigneeName = "someone";
        }
      }
      const body = assignmentCommentBody({ assigneeName, actorName: actor?.name, at });
      if (await insertSystemComment(getSupabaseClient, { tenantId, customerId, authorId: actor?.profileId, authorName: actor?.name, body, at })) n += 1;
    }
  } catch (e) {
    console.error("customer write comments failed:", e?.message || String(e));
  }
  return n;
}

/** SOQL-free helper: a Sundial_User__c row's display name. */
export function userDisplayName(u) {
  return [u?.First_Name__c, u?.Last_Name__c].filter(Boolean).join(" ").trim() || u?.Name || null;
}
