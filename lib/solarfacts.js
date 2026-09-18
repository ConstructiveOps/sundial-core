// lib/solarfacts.js — SolarFax (Solar Data Pros) monitoring hand-off for the Service Club
// (D-073.6, revised 2026-09-18 from their API docs:
// https://solardatapros.crunch.help/en/system-guides/api-docs).
//
// What Sundial needs from SolarFax is exactly two things, both `POST /users`:
//   1. On a paid membership: create (or update) the member as a SolarFax user with the
//      account's address and send them the "connect your utility" invite email
//      (`sendEmailTemplate.Name` = the tenant's white-labelled template).
//   2. When the membership ends: `disconnect` — SolarFax's "full disconnect and data
//      deletion for utility and solar".
// Auth is two headers per request, `Api-Key` and `Access-Token`, issued by SolarFax support.
// Per tenant in Secrets Manager `sundial/service-club`:
//   tenants[slug].solarFacts = { apiKey, accessToken, inviteTemplate, baseUrl?, test? }
// A tenant without `solarFacts` (or with only the older `solarFactsHookUrl` Zapier catch
// hook) still works — club.js falls back to the hook, then to "Not Applicable".
//
// Value-safety: the key and token never appear in logs; errors carry SolarFax's message only.

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
  if (inviteTemplate) body.sendEmailTemplate = { Name: inviteTemplate };
  if (test) body.test = "1";
  return body;
}

/** The end of a membership: SolarFax's full disconnect + data deletion for that user. */
export function disconnectBody({ firstName, lastName, email, test }) {
  const body = { user: { firstName: firstName || "", lastName: lastName || "", email: email || "" }, disconnect: "1", newOnly: "0" };
  if (test) body.test = "1";
  return body;
}

export class SolarFactsError extends Error {
  constructor(status, message, body) {
    super(message || `SolarFax answered ${status}`);
    this.name = "SolarFactsError";
    this.status = status;
    this.body = body;
  }
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
      throw new SolarFactsError(0, `SolarFax could not be reached: ${e?.message || e}`, null);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new SolarFactsError(res.status, json?.message || `SolarFax answered ${res.status}`, json);
    if (json?.success === false) throw new SolarFactsError(res.status, json?.message || "SolarFax refused the request", json);
    return json;
  }
  return {
    /** Create / update the member and send the connect invite. Returns { action, account_id, user_id, message }. */
    invite: (member) => call("POST", "users", inviteBody({ ...member, inviteTemplate: cfg.inviteTemplate, test: cfg.test })),
    /** Full disconnect + data deletion for the member. */
    disconnect: (member) => call("POST", "users", disconnectBody({ ...member, test: cfg.test })),
  };
}
