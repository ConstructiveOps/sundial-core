// Inbound lead webhook: POST /webhooks/leads/{source}/{token} -> a Sundial_Customer__c.
//
// The first (and today only) source is The Cool Down ("TCD"), which POSTs leads from its
// website straight to us — no Zapier in between (D-077).
//
// NO AUTHENTICATION BY DESIGN. TCD cannot sign a request, so the ONLY guard is the URL:
// its last segment is a long random slug known only to TCD, stored in Secrets Manager
// `sundial/lead-webhooks` as { "tcd": { "token": "…", "tenant": "harmon" } }. Rules:
//   - the slug is compared with constantTimeEquals (lib/secure-compare.js), never `===`;
//   - a wrong or missing slug is a BARE 404 with an empty body — the same answer as a
//     route that does not exist, so the URL space cannot be probed;
//   - the slug is checked BEFORE anything else is looked at (content type, size, body),
//     so an unauthenticated caller learns nothing about what we would accept;
//   - the slug is never logged, and the tenant comes from the SECRET, never the caller.
//
// A lead is a Lead: Status Lead, Stage = the first stage the org allows under Lead (read
// from describe — `New` on 2026-09-29), Customer Type Solar, Lead Source TCD, Country
// United States, Lead Date today in Phoenix. Every picklist goes through the match-or-skip
// guard (the Aurora rule): a value the org does not have is left unset and written into
// the notes with a loud warning — it never fails the insert of a real person's lead.
//
// DUPLICATES: a customer in this tenant with the same email (or, when the payload has no
// email, the same normalised phone) created in the last 30 days is returned as
// `duplicate: true` instead of creating another — TCD may retry on a timeout. This is a
// read followed by a create, NOT an atomic upsert: two deliveries of the same lead that
// arrive within the same second can both create. Accepted (Tim, 2026-09-29) and documented
// in docs/integrations/tcd-leads.md.
//
// Value-safety: logs carry the source, the record id, a MASKED email (t***@x.com) and
// field NAMES — never the slug, a full address, a phone number or the payload.

import { constantTimeEquals } from "../../lib/secure-compare.js";
import { parseJsonBody, normalizeHeaders, httpMethod } from "../../lib/http.js";
import { queryableFields, writeRecordToCache } from "../../lib/cache-row.js";

export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const CUSTOMER_CACHE_TABLE = "sundial_customer_cache";
// Must equal sundial-sf-query's CREATED_DATE_SOURCE.customer (the cache-row test pins it).
export const CUSTOMER_CREATED_DATE_SOURCE = ["Sunbase_Last_Updated__c", "Sunbase_Created_Date__c", "CreatedDate"];
export const TENANT_SF_OBJECT = "Sundial_Tenant__c";
export const LEAD_WEBHOOKS_SECRET = "sundial/lead-webhooks";
export const SERVICE_TIMEZONE = "America/Phoenix";

export const MAX_BODY_BYTES = 16 * 1024;
export const DUPLICATE_WINDOW_DAYS = 30;
// Where the "key: value" payload block goes. Visible on the Sales customer page as
// "Outreach Notes" (the setter's contact log), so the lead's own words are the log's
// first entry. Aurora_Import_Notes__c was the alternative; the portal never shows it.
export const NOTES_FIELD = "Outreach_Notes__c";
const NOTE_VALUE_MAX = 200;

/**
 * Per-source settings. The secret key is the source's slug in the URL. Adding a second
 * lead vendor is a new entry here + a new key in the secret + a route.
 */
export const LEAD_SOURCES = {
  tcd: {
    label: "The Cool Down (TCD)",
    leadSource: "TCD",
  },
};

// The Lead defaults the portal's New Customer form uses (NewCustomerModal.tsx).
export const LEAD_DEFAULTS = {
  Status__c: "Lead",
  Country__c: "United States",
  Customer_Type__c: "Solar",
};

// --- normalisation -----------------------------------------------------------

// Canonical payload key -> accepted aliases (canonical first; the first non-empty wins).
export const FIELD_ALIASES = {
  first_name: ["first_name"],
  last_name: ["last_name"],
  address1: ["address1", "address", "street"],
  city: ["city"],
  state: ["state"],
  zip_code: ["zip_code", "zip", "postal_code"],
  email: ["email"],
  phone: ["phone"],
};

function clean(v) {
  // "all strings" per the TCD contract; a bare number (zip 85001, phone 6025550100) is
  // what a sloppy sender produces and is unambiguous, so it is accepted as its digits.
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** Digits only, keeping one leading "+". "" when there are no digits. */
export function normalizePhone(v) {
  const s = clean(v);
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  return (s.startsWith("+") ? "+" : "") + digits;
}

/** The comparable core of a phone: its digits, minus a US country code. */
export function phoneKey(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Canonical lead from a raw payload: aliases resolved, everything trimmed, the phone
 * reduced to digits, the email lowercased. Unknown keys are ignored.
 * Also returns `received` — the recognised keys AS SENT (for the notes block).
 */
export function normalizeLead(body) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const lead = {};
  const received = [];
  for (const [canon, aliases] of Object.entries(FIELD_ALIASES)) {
    let value = "";
    for (const key of aliases) {
      const v = clean(src[key]);
      if (v) { value = v; received.push([key, v]); break; }
    }
    lead[canon] = value;
  }
  lead.email = lead.email.toLowerCase();
  lead.phone = normalizePhone(lead.phone);
  return { lead, received };
}

/**
 * Required: email OR phone, and first OR last name. Returns the missing requirement
 * NAMES (never a value). An email that is not an address counts as absent.
 */
export function missingRequirements(lead) {
  const missing = [];
  const hasEmail = EMAIL_RE.test(lead.email || "");
  if (!hasEmail && !lead.phone) missing.push("email or phone");
  if (!lead.first_name && !lead.last_name) missing.push("first_name or last_name");
  return missing;
}

/** "t***@x.com" — enough to find a log line, not enough to identify a person. */
export function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at < 1) return s ? "***" : "";
  return `${s[0]}***${s.slice(at)}`;
}

// --- schema / picklist guard ---------------------------------------------------

/**
 * Match a value against a picklist case/punctuation-insensitively and return the org's
 * CANONICAL value (same rule as sundial-aurora-inbound/customerCreate.js).
 */
export function matchPicklist(value, picklistValues = []) {
  const raw = clean(value);
  if (!raw) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(raw);
  return picklistValues.find((v) => norm(v) === target) ?? null;
}

/** Bit i of a dependent picklist's base64 validFor bitmap (high bit first, as Salesforce packs it). */
export function validForIndex(validFor, i) {
  if (!validFor) return false;
  const bytes = Buffer.from(validFor, "base64");
  const byte = bytes[i >> 3];
  return byte !== undefined && (byte & (0x80 >> (i % 8))) !== 0;
}

/**
 * The small schema surface the mapper needs, over a raw describe.
 *   has(name) · type(name) · length(name) · picklistValues(name)  (active values)
 *   firstDependentValue(field, controllerValue)  the first ACTIVE value of a dependent
 *     picklist that is valid for that controlling value, in the org's own order.
 */
export function schemaFromDescribe(describe) {
  const byName = new Map((describe?.fields || []).map((f) => [f.name, f]));
  const active = (f) => (f?.picklistValues || []).filter((p) => p.active !== false);
  return {
    has: (n) => byName.has(n),
    type: (n) => byName.get(n)?.type ?? null,
    length: (n) => byName.get(n)?.length ?? 0,
    createable: (n) => byName.get(n)?.createable !== false,
    picklistValues: (n) => active(byName.get(n)).map((p) => p.value),
    firstDependentValue(fieldName, controllerValue) {
      const field = byName.get(fieldName);
      const controller = field?.controllerName ? byName.get(field.controllerName) : null;
      if (!field || !controller) return null;
      const idx = (controller.picklistValues || []).findIndex((p) => p.value === controllerValue);
      if (idx < 0) return null;
      return active(field).find((p) => validForIndex(p.validFor, idx))?.value ?? null;
    },
  };
}

// US state / territory names -> USPS code. The org's State__c holds codes ("AZ"), but a
// web form may send the full name. Matching is done against the ORG's values after this.
const STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", districtofcolumbia: "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", newhampshire: "NH", newjersey: "NJ", newmexico: "NM",
  newyork: "NY", northcarolina: "NC", northdakota: "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", rhodeisland: "RI", southcarolina: "SC", southdakota: "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  westvirginia: "WV", wisconsin: "WI", wyoming: "WY", puertorico: "PR",
};

/** A 2-letter code or a full state name -> the org's canonical State__c value, or null. */
export function matchState(value, picklistValues) {
  const raw = clean(value);
  if (!raw) return null;
  const direct = matchPicklist(raw, picklistValues);
  if (direct) return direct;
  const code = STATE_NAMES[raw.toLowerCase().replace(/[^a-z]/g, "")];
  return code ? matchPicklist(code, picklistValues) : null;
}

// --- dates -----------------------------------------------------------------------

/** YYYY-MM-DD of an instant in Phoenix. */
export function phoenixDate(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SERVICE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// --- mapping -----------------------------------------------------------------------

/** The short "key: value" block for the notes field. */
export function buildNotesBlock({ sourceLabel, received, extras = [], at = new Date() }) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: SERVICE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit",
  }).format(at);
  const lines = [`Lead received from ${sourceLabel} — ${when} (Arizona)`];
  for (const [k, v] of received) lines.push(`${k}: ${String(v).slice(0, NOTE_VALUE_MAX)}`);
  for (const e of extras) if (e) lines.push(e);
  return lines.join("\n");
}

/**
 * Map a normalised lead onto Sundial_Customer__c fields, describe-guarded.
 * @returns {{ fields: object, warnings: string[] }}
 */
export function buildLeadCustomerFields({ lead, received, source, tenantId, schema, at = new Date() }) {
  const cfg = LEAD_SOURCES[source];
  const fields = {};
  const warnings = [];
  const notes = [];

  const set = (name, value) => {
    if (value === null || value === undefined || value === "") return;
    if (!schema.has(name)) {
      warnings.push(`Salesforce has no field ${name} — not written.`);
      return;
    }
    // A string longer than the field fails the WHOLE insert (STRING_TOO_LONG) and TCD
    // would retry it forever. Truncate to the describe length instead.
    const max = schema.length(name);
    if (typeof value === "string" && max > 0 && value.length > max) value = value.slice(0, max);
    fields[name] = value;
  };
  // Picklist: canonical value on a match; otherwise unset + note + warning.
  const setPicklist = (name, wanted, label = name) => {
    if (!wanted) return;
    if (!schema.has(name)) {
      warnings.push(`Salesforce has no field ${name} — "${wanted}" not written.`);
      notes.push(`${label} (field missing): ${wanted}`);
      return;
    }
    const matched = matchPicklist(wanted, schema.picklistValues(name));
    if (matched) fields[name] = matched;
    else {
      warnings.push(`${name} has no "${wanted}" value in this org — left unset; recorded in ${NOTES_FIELD}.`);
      notes.push(`${label} (not in picklist): ${wanted}`);
    }
  };

  set("First_Name__c", lead.first_name);
  set("Last_Name__c", lead.last_name);
  set("Name", [lead.first_name, lead.last_name].filter(Boolean).join(" "));
  set("Street__c", lead.address1);
  set("City__c", lead.city);
  set("Postal_Code__c", lead.zip_code);

  if (lead.state) {
    const st = schema.has("State__c") ? matchState(lead.state, schema.picklistValues("State__c")) : null;
    if (st) fields.State__c = st;
    else {
      warnings.push(`State "${lead.state}" is not in the State__c picklist — left unset; recorded in ${NOTES_FIELD}.`);
      notes.push(`State (not in picklist): ${lead.state}`);
    }
  }

  if (EMAIL_RE.test(lead.email)) set("Primary_Email__c", lead.email);
  else if (lead.email) {
    // Salesforce rejects a malformed email field outright; keep the person, note the value.
    warnings.push(`email is not a valid address — Primary_Email__c left unset; recorded in ${NOTES_FIELD}.`);
    notes.push(`Email (invalid): ${lead.email}`);
  }
  set("Primary_Phone__c", lead.phone);

  setPicklist("Country__c", LEAD_DEFAULTS.Country__c, "Country");
  setPicklist("Status__c", LEAD_DEFAULTS.Status__c, "Status");
  setPicklist("Customer_Type__c", LEAD_DEFAULTS.Customer_Type__c, "Customer type");
  setPicklist("Lead_Source__c", cfg.leadSource, "Lead source");

  // Stage: the first stage the org allows under the Status we actually wrote.
  if (fields.Status__c && schema.has("Stage__c")) {
    const stage = schema.firstDependentValue("Stage__c", fields.Status__c);
    if (stage) fields.Stage__c = stage;
    else warnings.push(`No Stage__c value is valid under Status "${fields.Status__c}" — Stage left unset.`);
  }

  if (schema.has("Lead_Date__c")) fields.Lead_Date__c = phoenixDate(at);
  set("Client__c", tenantId);

  if (schema.has(NOTES_FIELD)) {
    fields[NOTES_FIELD] = buildNotesBlock({ sourceLabel: cfg.label, received, extras: notes, at });
  } else {
    warnings.push(`Salesforce has no field ${NOTES_FIELD} — the payload notes were not written.`);
  }

  return { fields, warnings };
}

// --- duplicates ------------------------------------------------------------------

/**
 * The SOQL for the duplicate check. Email when the payload has one (Salesforce compares
 * it case-insensitively); otherwise a LIKE on the phone's last four digits, narrowed to
 * an exact digits match in code (stored phones carry any punctuation).
 * @returns {{ soql: string, by: "email"|"phone" } | null}
 */
export function duplicateQuery({ lead, tenantId, now = new Date(), esc }) {
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const base = `FROM ${CUSTOMER_SF_OBJECT} WHERE Client__c = '${esc(tenantId)}' AND CreatedDate >= ${since}`;
  if (EMAIL_RE.test(lead.email)) {
    return { by: "email", soql: `SELECT Id ${base} AND Primary_Email__c = '${esc(lead.email)}' ORDER BY CreatedDate DESC LIMIT 1` };
  }
  const key = phoneKey(lead.phone);
  if (key.length >= 4) {
    return { by: "phone", soql: `SELECT Id, Primary_Phone__c ${base} AND Primary_Phone__c LIKE '%${esc(key.slice(-4))}' ORDER BY CreatedDate DESC LIMIT 200` };
  }
  return null;
}

/** The duplicate's id from the query rows, or null. */
export function pickDuplicate(by, rows, lead) {
  if (!rows?.length) return null;
  if (by === "email") return rows[0].Id;
  const key = phoneKey(lead.phone);
  return rows.find((r) => phoneKey(r.Primary_Phone__c) === key)?.Id ?? null;
}

// --- handler -----------------------------------------------------------------------

/**
 * Salesforce's error CODES and FIELD NAMES from a failed call — never its message, which
 * can echo a submitted value ("bad value for restricted picklist field: …").
 */
export function sfErrorSummary(e) {
  try {
    const body = JSON.parse(e?.sfBody || "null");
    const list = Array.isArray(body) ? body : body ? [body] : [];
    const parts = list.map((x) => [x.errorCode, ...(x.fields || [])].filter(Boolean).join(":")).filter(Boolean);
    if (parts.length) return parts.join(", ");
  } catch { /* not JSON */ }
  return e?.sfStatus ? `HTTP ${e.sfStatus}` : "no response";
}

const EMPTY_404 = { statusCode: 404, headers: {}, body: "" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (statusCode, obj) => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(obj) });

/** Which source does the request name? From the REST resource (…/leads/{source}/{token}). */
export function sourceFromEvent(event) {
  const path = String(event?.resource || event?.path || "");
  const m = path.match(/\/webhooks\/leads\/([a-z0-9-]+)(?:\/|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * @param {object} d  injected dependencies
 *   getLeadConfig(source) -> { token, tenant } | null   (the secret entry)
 *   sfQuery, sfCreateRecord, describeObject, soqlEscapeString
 *   getSupabaseClient, getCacheColumns(table)
 *   now() -> Date, log / warn / error
 */
export function createIntakeHandler(d) {
  const log = d.log || console.log;
  const warn = d.warn || console.warn;
  const error = d.error || console.error;
  const now = d.now || (() => new Date());

  // Tenant slug -> Sundial_Tenant__c id, cached (30 min) like customerCreate.js.
  const tenantCache = new Map();
  async function tenantIdFor(slug) {
    if (!slug || !/^[a-z0-9-]{1,40}$/i.test(slug)) return null;
    const hit = tenantCache.get(slug);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.id;
    const rows = await d.sfQuery(`SELECT Id FROM ${TENANT_SF_OBJECT} WHERE Name = '${d.soqlEscapeString(slug)}' LIMIT 1`);
    const id = rows?.[0]?.Id ?? null;
    if (id) tenantCache.set(slug, { id, at: Date.now() });
    return id;
  }

  return async function handleLead(event) {
    const source = sourceFromEvent(event);
    const cfg = source ? LEAD_SOURCES[source] : null;
    if (!cfg || httpMethod(event) !== "POST") return EMPTY_404;

    // --- THE GATE: the URL slug, constant-time, before anything else ---------------
    let conf;
    try {
      conf = await d.getLeadConfig(source);
    } catch (e) {
      error(`lead-intake[${source}]: cannot read ${LEAD_WEBHOOKS_SECRET}: ${e?.message || e}`);
      return EMPTY_404; // fail closed
    }
    const expected = typeof conf?.token === "string" ? conf.token : "";
    const provided = event?.pathParameters?.token;
    if (!expected || typeof provided !== "string" || provided === "" || !constantTimeEquals(provided, expected)) {
      warn(`lead-intake[${source}]: rejected — missing or wrong URL slug.`);
      return EMPTY_404;
    }

    // --- shape ----------------------------------------------------------------------
    const headers = normalizeHeaders(event?.headers);
    if (!/^application\/json\b/i.test(String(headers["content-type"] || ""))) {
      return json(415, { ok: false, error: "unsupported_media_type", message: "Send Content-Type: application/json." });
    }
    const rawBody = event?.body == null ? "" : String(event.body);
    const bytes = event?.isBase64Encoded ? Math.floor(rawBody.length * 3 / 4) : Buffer.byteLength(rawBody, "utf8");
    if (bytes > MAX_BODY_BYTES) return json(413, { ok: false, error: "payload_too_large", message: "Body exceeds 16 KB." });
    const parsed = parseJsonBody(event);
    if (!parsed.ok || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
      return json(400, { ok: false, error: "invalid_json", message: "Body must be a JSON object." });
    }

    const { lead, received } = normalizeLead(parsed.data);
    const missing = missingRequirements(lead);
    if (missing.length) {
      return json(400, { ok: false, error: "missing_fields", missing, message: `Required: ${missing.join("; ")}.` });
    }

    const masked = maskEmail(lead.email);
    try {
      const tenantId = await tenantIdFor(conf.tenant);
      if (!tenantId) {
        error(`lead-intake[${source}]: tenant "${conf.tenant}" from ${LEAD_WEBHOOKS_SECRET} does not resolve to a ${TENANT_SF_OBJECT}.`);
        return json(502, { ok: false, error: "upstream_error" });
      }

      // Duplicates (read-then-create; see the header for the accepted race).
      const q = duplicateQuery({ lead, tenantId, now: now(), esc: d.soqlEscapeString });
      if (q) {
        const dupId = pickDuplicate(q.by, await d.sfQuery(q.soql), lead);
        if (dupId) {
          log(`lead-intake[${source}]: duplicate by ${q.by} (${masked || "no email"}) -> ${dupId}`);
          return json(200, { ok: true, id: dupId, duplicate: true });
        }
      }

      const describe = await d.describeObject(CUSTOMER_SF_OBJECT);
      const schema = schemaFromDescribe(describe);
      const { fields, warnings } = buildLeadCustomerFields({ lead, received, source, tenantId, schema, at: now() });
      for (const w of warnings) {
        // The lead source going missing is the loud one: TCD's cohort report keys off it.
        (w.startsWith("Lead_Source__c") ? error : warn)(`lead-intake[${source}] WARNING: ${w}`);
      }

      const { id } = await d.sfCreateRecord(CUSTOMER_SF_OBJECT, fields);
      log(`lead-intake[${source}]: created ${id} (${masked || "no email"}) stage=${fields.Stage__c ?? "-"}`);

      // Cache row, so the lead is in Sales now rather than at the next sync. Best-effort.
      try {
        const supabase = await d.getSupabaseClient();
        const columnSet = await d.getCacheColumns(CUSTOMER_CACHE_TABLE);
        await writeRecordToCache({
          supabase, sfQuery: d.sfQuery, soqlEscapeString: d.soqlEscapeString,
          sfObject: CUSTOMER_SF_OBJECT, cacheTable: CUSTOMER_CACHE_TABLE,
          fields: queryableFields(describe), columnSet, id, tenantId, tenantSlug: conf.tenant,
          createdDateSources: CUSTOMER_CREATED_DATE_SOURCE,
        });
      } catch (e) {
        warn(`lead-intake[${source}]: cache row for ${id} not written (the sync will pick it up): ${e?.message || e}`);
      }

      return json(200, { ok: true, id });
    } catch (e) {
      error(`lead-intake[${source}]: Salesforce failure for ${masked || "a lead with no email"} — ${sfErrorSummary(e)}`);
      return json(502, { ok: false, error: "upstream_error" });
    }
  };
}
