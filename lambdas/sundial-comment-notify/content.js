// Record links and email content for @-mention alerts.
//
// Pure and side-effect free, which is the point: the link map is the piece most likely
// to be wrong and the piece most likely to be edited by someone adding a module, so it
// is the piece that should be directly testable without a Supabase or an SES.

/**
 * Object key -> portal path template.
 *
 * `comments.record_object` carries the same short key the API uses (`customer`,
 * `solar`, `roofing`), and harmon-crm routes those three paths. WHEN THE SERVICE
 * MODULE LANDS IT GETS ONE ENTRY HERE — that is the whole change.
 */
export const RECORD_PATHS = {
  customer: (id) => `/customers/${id}`,
  solar: (id) => `/projects/solar/${id}`,
  roofing: (id) => `/projects/roofing/${id}`,
};

/**
 * Where an unrecognized object key sends the reader.
 *
 * NEVER GUESS A PATH. A link built from an unknown key would 404, and a 404 from a
 * notification email reads as "the portal is broken" rather than "we don't support that
 * link yet" — the reader has no way to tell the difference. The dashboard is a real
 * page that always exists, and the email still tells them who mentioned them and what
 * they said, so the notification retains all of its value except the shortcut.
 */
export const FALLBACK_PATH = "/dashboard";

/**
 * Build the deep link for a record.
 *
 * @param {string} baseUrl - PORTAL_BASE_URL, already trailing-slash-trimmed
 * @param {string} objectKey - comments.record_object
 * @param {string} recordId - comments.record_id
 * @returns {{ url: string, known: boolean }} `known:false` means the caller should warn
 */
export function recordLink(baseUrl, objectKey, recordId) {
  const key = String(objectKey ?? "").trim().toLowerCase();
  const build = RECORD_PATHS[key];
  if (!build || !recordId) {
    return { url: `${baseUrl}${FALLBACK_PATH}`, known: false };
  }
  return { url: `${baseUrl}${build(encodeURIComponent(recordId))}`, known: true };
}

/**
 * A human label for the record, for the subject line.
 *
 * `recordName` is best-effort (looked up from the Supabase cache; see notify.js). When
 * it is missing we fall back to "<object> <id>" rather than dropping the clause — an
 * opaque id still tells the reader WHICH record, and a subject with a dangling "on"
 * looks broken.
 */
export function recordLabel(objectKey, recordId, recordName) {
  if (recordName && String(recordName).trim() !== "") return String(recordName).trim();
  const key = String(objectKey ?? "record").trim() || "record";
  return recordId ? `${key} ${recordId}` : key;
}

/** Minimal HTML escaping — the comment body is user input going into an HTML mail. */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the subject and both bodies.
 *
 * The comment text is included IN FULL. This is a notification whose entire job is to
 * save the reader a trip to the portal; a truncated body sends them there anyway, which
 * is the same as not sending it. (The link is right there for context and replies.)
 *
 * @returns {{ subject: string, text: string, html: string }}
 */
export function buildMentionEmail({ authorName, commentBody, label, url }) {
  const who = authorName && String(authorName).trim() !== "" ? String(authorName).trim() : "Someone";
  const body = String(commentBody ?? "").trim();

  const subject = `${who} mentioned you on ${label}`;

  const text = [
    `${who} mentioned you in a comment on ${label}.`,
    "",
    body || "(no comment text)",
    "",
    `Open the record: ${url}`,
    "",
    "— Sundial",
    "You can turn these alerts off in Settings.",
  ].join("\n");

  // Plain, table-free HTML: this is a transactional notification, and every mail client
  // renders a paragraph and a link correctly. The blockquote is the only styling that
  // earns its place — it separates somebody else's words from ours.
  const html = [
    `<p><strong>${escapeHtml(who)}</strong> mentioned you in a comment on <strong>${escapeHtml(label)}</strong>.</p>`,
    `<blockquote style="margin:16px 0;padding:8px 16px;border-left:3px solid #d0d7de;color:#24292f;white-space:pre-wrap;">${escapeHtml(body) || "<em>(no comment text)</em>"}</blockquote>`,
    `<p><a href="${escapeHtml(url)}">Open the record</a></p>`,
    `<hr style="border:none;border-top:1px solid #eaeef2;margin:24px 0;">`,
    `<p style="color:#57606a;font-size:12px;">Sundial — you can turn these alerts off in Settings.</p>`,
  ].join("\n");

  return { subject, text, html };
}
