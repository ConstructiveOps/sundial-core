// lib/solarfacts.js — SolarFax (Solar Data Pros) monitoring hand-off for the Service Club
// (D-073.6, revised 2026-09-18 from their API docs:
// https://solardatapros.crunch.help/en/system-guides/api-docs).
//
// What Sundial needs from SolarFax is exactly two things, both `POST /users`:
//   1. On a paid membership: create (or update) the member as a SolarFax user with the
//      account's address and send them the "connect your utility" invite email
//      (`sendEmailTemplate` = the template's name as a plain string, e.g. "Monitoring Welcome Email").
//   2. When the membership ends: `disconnect` — SolarFax's "full disconnect and data
//      deletion for utility and solar".
// Auth is two headers per request, `Api-Key` and `Access-Token`, issued by SolarFax support.
// Per tenant in Secrets Manager `sundial/service-club`:
//   tenants[slug].solarFacts = { apiKey, accessToken, inviteTemplate, baseUrl?, test? }
// `test` is ALWAYS sent, "1" or "0": SolarFax's API treats an absent `test` as ON (validate,
// do nothing), so a real user is only created when we say "0" explicitly — SolarFax support,
// 2026-10-28.
// A tenant without `solarFacts` (or with only the older `solarFactsHookUrl` Zapier catch
// hook) still works — club.js falls back to the hook, then to "Not Applicable".
//
// Value-safety: the key and token never appear in logs. A failure is logged with SolarFax's
// status + response body and our request body with the member's email masked.

export const SOLARFACTS_API = "https://api.solardatapros.com/api/v1";

/** The tenant's SolarFax config out of the club secret entry, or null. */
export function solarFactsConfigFor(tenantEntry) {
  const s = tenantEntry?.solarFacts;
  if (!s || typeof s !== "object") return null;
  const apiKey = String(s.apiKey || "").trim();
  const accessToken = String(s.accessToken || "").trim();
  if (!apiKey || !accessToken) return null;
  return {
    apiKey,
    accessToken,
    inviteTemplate: String(s.inviteTemplate || "").trim() || null,
    baseUrl: String(s.baseUrl || SOLARFACTS_API).replace(/\/+$/, ""),
    test: s.test === true || s.test === "1",
  };
}

/** Split "Ann Lee" when the customer hub has no first/last. */
export function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/**
 * The invite: a SolarFax user with login + weekly emails, the account's address, the
 * white-labelled connect email. `newOnly` is off so an existing SolarFax user (a member
 * who joined before, or one SolarFax already knew) is updated rather than refused.
 */
export function inviteBody({ firstName, lastName, email, phone, street, city, state, zip, inviteTemplate, test }) {
  const body = {
    user: { firstName: firstName || "", lastName: lastName || "", email: email || "", enableAccess: "1", enableEmails: "1" },
    account: { phone: phone || "", addressOne: street || "", city: city || "", state: state || "", zip: zip || "", isLead: "0" },
    newOnly: "0",
  };
  // A plain string, not { Name } — SolarFax support, 2026-10-28.
  if (inviteTemplate) body.sendEmailTemplate = inviteTemplate;
  // Never omitted: SolarFax defaults an absent `test` to ON (see the top of the file).
  body.test = test ? "1" : "0";
  return body;
}

/** The end of a membership: SolarFax's full disconnect + data deletion for that user. */
export function disconnectBody({ firstName, lastName, email, test }) {
  // `test` never omitted, as in the invite.
  return { user: { firstName: firstName || "", lastName: lastName || "", email: email || "" }, disconnect: "1", newOnly: "0", test: test ? "1" : "0" };
}

export class SolarFactsError extends Error {
  // `request` is the JSON body we sent (no credentials — those are headers), kept so a
  // failure can be logged with the email masked and support can match it on their side.
  constructor(status, message, body, request = null) {
    super(message || `SolarFax answered ${status}`);
    this.name = "SolarFactsError";
    this.status = status;
    this.body = body;
    this.request = request;
  }
}

/** "ann@gmail.com" → "a***@gmail.com": enough for SolarFax support to match, not a full address in a log. */
export function maskEmail(email) {
  const s = String(email || "");
  const at = s.lastIndexOf("@");
  if (at < 1) return s ? "***" : "";
  return `${s[0]}***${s.slice(at)}`;
}

/** The request body for a log line: a copy with the user's email masked. */
export function maskedRequest(request) {
  if (!request || typeof request !== "object") return request ?? null;
  const copy = JSON.parse(JSON.stringify(request));
  if (copy.user && typeof copy.user === "object" && "email" in copy.user) copy.user.email = maskEmail(copy.user.email);
  return copy;
}

/**
 * The membership's SolarFacts_Last_Error__c for a SolarFactsError:
 * "<status>: <message> — <first 200 chars of SolarFax's JSON body>", 255 max. SolarFax's
 * body is what support asks for; the message alone ("Invalid Api-Key") rarely says which field.
 */
export function solarFactsErrorText(err) {
  let text = `${err?.status ?? 0}: ${err?.message || "SolarFax error"}`;
  if (err?.body != null) {
    let body;
    try { body = JSON.stringify(err.body); } catch { body = String(err.body); }
    if (body && body !== "{}") text += ` — ${body.slice(0, 200)}`;
  }
  return text.slice(0, 255);
}

/** The client. `fetchUrl` is injectable so tests never touch the network. */
export function createSolarFactsClient(cfg, { fetchUrl = (url, init) => fetch(url, { signal: AbortSignal.timeout(15000), ...init }) } = {}) {
  if (!cfg?.apiKey || !cfg?.accessToken) throw new Error("solarfacts: no credentials");
  async function call(method, path, body) {
    const headers = { "Api-Key": cfg.apiKey, "Access-Token": cfg.accessToken, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetchUrl(`${cfg.baseUrl}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new SolarFactsError(0, `SolarFax could not be reached: ${e?.message || e}`, null, body ?? null);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new SolarFactsError(res.status, json?.message || `SolarFax answered ${res.status}`, json, body ?? null);
    if (json?.success === false) throw new SolarFactsError(res.status, json?.message || "SolarFax refused the request", json, body ?? null);
    return json;
  }
  return {
    /** Create / update the member and send the connect invite. Returns { action, account_id, user_id, message }. */
    invite: (member) => call("POST", "users", inviteBody({ ...member, inviteTemplate: cfg.inviteTemplate, test: cfg.test })),
    /** Full disconnect + data deletion for the member. */
    disconnect: (member) => call("POST", "users", disconnectBody({ ...member, test: cfg.test })),
  };
}
