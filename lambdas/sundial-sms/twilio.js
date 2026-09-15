// Twilio helpers for sundial-sms: the REST send, the webhook signature check, phone
// normalization. Pure functions plus one fetch wrapper, so test.js can drive them
// without the network.
//
// WHY WE TALK TO TWILIO WITH fetch AND NOT THE SDK: one endpoint (create a Message) and
// one algorithm (the request signature) are all we use, and the SDK would add ~10 MB to
// a bundle that ships through deploy.ps1's esbuild step. Both are documented, stable,
// and small enough to own.
//
// Value-safety: the auth token is never logged, and neither is a message body — a
// customer's text is customer data (the rule in lib/email.js applies here too).

import { createHmac, timingSafeEqual } from "node:crypto";

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Digits only. "(602) 555-1212" -> "6025551212"; "+1 602…" -> "16025551212". */
export function digitsOf(v) {
  return String(v ?? "").replace(/\D/g, "");
}

/**
 * Normalize a phone to E.164 for North America: 10 digits get +1, 11 digits starting
 * with 1 get +. Anything else returns null — better to refuse a send than to text a
 * number we could not make sense of.
 */
export function toE164(v) {
  const d = digitsOf(v);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** The last ten digits — what two spellings of one number have in common. */
export function last10(v) {
  const d = digitsOf(v);
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Pretty form for the office: +16025551212 -> (602) 555-1212. */
export function prettyPhone(v) {
  const t = last10(v);
  return t ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(v ?? "");
}

/**
 * Twilio's request signature: base64(HMAC-SHA1(authToken, url + concat(sorted
 * key+value))) for form posts. The URL is the FULL URL Twilio requested, exactly as
 * configured in the console (scheme, host, path, query). A mismatch there — a
 * trailing slash, a different stage name — fails validation, which is the intended
 * behaviour and the first thing to check when the webhook rejects everything.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function expectedSignature(authToken, url, params) {
  const keys = Object.keys(params || {}).sort();
  let data = url;
  for (const k of keys) data += k + String(params[k] ?? "");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validateSignature(authToken, url, params, provided) {
  if (!authToken || !provided) return false;
  const want = Buffer.from(expectedSignature(authToken, url, params));
  const got = Buffer.from(String(provided));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** application/x-www-form-urlencoded body (base64-decoded when API Gateway flagged it) -> object. */
export function parseFormBody(event) {
  let raw = event?.body;
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (event?.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  const out = {};
  for (const [k, v] of new URLSearchParams(String(raw))) out[k] = v;
  return out;
}

/**
 * The URL Twilio signed. SMS_WEBHOOK_BASE (env) is the operator's statement of the
 * public base ("https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod"); without
 * it the URL is rebuilt from the request (host + stage path), which is right for the
 * default API Gateway domain.
 */
export function requestUrl(event, headers, webhookBase = null) {
  return requestUrls(event, headers, webhookBase)[0];
}

/**
 * Every spelling of the request URL Twilio could have signed, most likely first. The
 * signature is over the URL EXACTLY as pasted into the Twilio console, and the two
 * honest ways to spell the same endpoint (the operator's SMS_WEBHOOK_BASE and the
 * gateway's own host + stage path) can differ by a trailing slash or a custom domain —
 * so the caller tries each rather than failing on a spelling. The set is tiny and
 * every candidate is still an https URL for THIS request's path, so nothing is
 * weakened: a forged request still has to carry a valid HMAC for one of them.
 */
export function requestUrls(event, headers, webhookBase = null) {
  const rawPath = event?.requestContext?.path || event?.rawPath || event?.path || "";
  const stage = event?.requestContext?.stage;
  const stageless = stage && rawPath.startsWith(`/${stage}/`) ? rawPath.slice(stage.length + 1) : rawPath;
  const qs = event?.rawQueryString || (event?.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : "");
  const host = headers?.["host"] || event?.requestContext?.domainName || "";
  const out = [];
  if (webhookBase) out.push(`${webhookBase.replace(/\/+$/, "")}${stageless}`);
  if (host) {
    out.push(`https://${host}${rawPath}`);
    if (stageless !== rawPath) out.push(`https://${host}${stageless}`); // custom domain with the stage mapped away
  }
  const withQs = qs ? out.map((u) => `${u}?${qs}`) : out;
  // A trailing-slash variant of each, since the console accepts either spelling.
  const all = withQs.flatMap((u) => (u.includes("?") ? [u] : [u, `${u}/`]));
  return [...new Set(all)];
}

/** Inbound MMS attachments: MediaUrl0..N with their content types. */
export function mediaFrom(params) {
  const n = Number(params?.NumMedia ?? 0) || 0;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const url = params[`MediaUrl${i}`];
    if (url) out.push({ url, contentType: params[`MediaContentType${i}`] ?? null });
  }
  return out;
}

/**
 * Send one SMS. Resolves { ok, sid, status } or { ok:false, error, code } — never
 * throws on a Twilio-side refusal, so the caller can store the failure on the row.
 *
 * @param {{ accountSid:string, authToken:string }} creds
 * @param {{ from:string, to:string, body:string, statusCallback?:string }} msg
 * @param {typeof fetch} fetchImpl
 */
export async function sendSms(creds, msg, fetchImpl = fetch) {
  const form = new URLSearchParams({ From: msg.from, To: msg.to, Body: msg.body });
  if (msg.statusCallback) form.set("StatusCallback", msg.statusCallback);
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
  let resp;
  try {
    resp = await fetchImpl(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { ok: false, error: `twilio unreachable: ${e?.message || e}`, code: null };
  }
  let data = {};
  try {
    data = await resp.json();
  } catch {
    /* non-JSON error page */
  }
  if (!resp.ok) {
    return { ok: false, error: data?.message || `twilio HTTP ${resp.status}`, code: data?.code != null ? String(data.code) : null };
  }
  return { ok: true, sid: data.sid ?? null, status: data.status ?? "queued" };
}
