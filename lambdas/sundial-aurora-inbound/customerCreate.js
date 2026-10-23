// Auto-create a Sundial_Customer__c from an Aurora project (dealer origination).
//
// WHY: Harmon works with third-party dealers who originate deals entirely inside
// Aurora, in Harmon's own tenant. Their agreement events reach our webhook, but no
// Sundial_Customer__c exists — the design request that normally creates the Aurora
// project never happened. A SIGNED agreement from one of those is a real sale, so
// the worker builds the customer from Aurora's data instead of dead-lettering.
// Non-signed dealer events create nothing (D-049).
//
// Everything here is describe-guarded and best-effort about OPTIONAL values: a
// missing email, phone, address component, or picklist match must never fail the
// creation of a customer who has just signed a contract. Anything retrieved but not
// mappable is written to the import-notes field rather than dropped.
//
// Field surface verified against Aurora's public Retrieve Project reference
// (2026-08-07) — see lib/aurora.js » getProject and
// docs/integrations/aurora-api-reference.md.

import { sfQuery, soqlEscapeString, sfUpsertRecord } from "../../lib/salesforce.js";
import { AuroraError, listPartners, getUser } from "../../lib/aurora.js";
import { resolveDealerAlias } from "../../lib/dealer-aliases.js";

export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const EXTERNAL_ID_FIELD = "Aurora_Project_ID__c";

// New fields for this feature; neither exists yet (describe 2026-08-07).
export const F_DEALER_NAME = "Aurora_Dealer_Name__c";
export const F_IMPORT_NOTES = "Aurora_Import_Notes__c";

// Lead_Source__c on an auto-created customer is the DEALER — the resolved
// Sundial_Dealer__c Name, else the raw Aurora partner name (D-085 am. 1, 2026-10-22).
// The single generic "Aurora - Third-Party Dealer" tag is gone: it told Harmon a deal came
// from "a dealer" and not which one. The org's picklist already carries ~200
// partner-specific values, and Tim is unrestricting it — see buildLeadSource.

// Where a SIGNED deal lands in the pipeline. Aurora's `signed` status translates to
// exactly these two values in Sundial (Tim, 2026-08-10) — for EVERY signed event,
// whether the customer was auto-created from a dealer project or already existed
// with a matching Aurora_Project_ID__c. Harmon's Salesforce alerts trigger off the
// Stage, so this write is the notification mechanism, not a cosmetic status.
//
// Status__c matters more than it looks: the org default is "Lead", so without this
// a closed sale would sit in the CRM as a lead.
//
// Both go through the same match-or-skip guard as every other picklist: a value that
// is renamed or removed in the org must degrade to a warning, never fail the
// processing of a signed contract.
export const SIGNED_STATUS = "Customer";
export const SIGNED_STAGE = "Sold - Pending Review";

/**
 * The pipeline fields every signed event writes, resolved against the live describe.
 * Shared by the auto-create path and the matched/repaired-customer path so the two
 * can never drift apart.
 *
 * @param {{ has:(n:string)=>boolean, picklistValues:(n:string)=>string[] }} schema
 * @returns {{ fields: object, warnings: string[], notes: string[] }}
 */
export function buildSignedPipelineFields(schema) {
  const fields = {};
  const warnings = [];
  const notes = [];
  for (const [field, wanted] of [
    ["Status__c", SIGNED_STATUS],
    ["Stage__c", SIGNED_STAGE],
  ]) {
    if (!schema.has(field)) {
      warnings.push(`Salesforce has no field ${field} — "${wanted}" not written.`);
      notes.push(`${field} (field missing): ${wanted}`);
      continue;
    }
    const matched = matchPicklist(wanted, schema.picklistValues(field));
    if (matched) {
      fields[field] = matched;
    } else {
      warnings.push(
        `${field} has no "${wanted}" value in this org — left unset. Add the picklist value (see TASKS.md); Harmon's Salesforce alerts key off this Stage, so they will NOT fire until it exists.`
      );
      notes.push(`${field} (not in picklist): ${wanted}`);
    }
  }
  return { fields, warnings, notes };
}

// Which tenant these records belong to. Resolved from the tenant SLUG rather than a
// hardcoded Salesforce id: the id is deploy-specific, the slug is the same identity
// used by VITE_TENANT_ID, the S3 prefix, and client-config.ts (D-034). Env var so a
// second tenant is a config change, not a code change.
const TENANT_SLUG = process.env.SUNDIAL_TENANT_SLUG || "harmon";
const TENANT_TTL_MS = 30 * 60 * 1000;
let tenantCache = null; // { id, fetchedAt }

/** Resolve (and cache) the Sundial_Tenant__c record id for this deployment. */
export async function resolveTenantId() {
  if (tenantCache && Date.now() - tenantCache.fetchedAt < TENANT_TTL_MS) {
    return tenantCache.id;
  }
  const rows = await sfQuery(
    `SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT_SLUG)}' LIMIT 1`
  );
  const id = rows?.[0]?.Id ?? null;
  if (!id) {
    throw new Error(
      `No Sundial_Tenant__c named "${TENANT_SLUG}" (SUNDIAL_TENANT_SLUG) — cannot set Client__c on an auto-created customer.`
    );
  }
  tenantCache = { id, fetchedAt: Date.now() };
  return id;
}

/** Test seam / rotation: drop the cached tenant id. */
export function resetTenantCache() {
  tenantCache = null;
}

// --- dealer attribution -----------------------------------------------------

// Aurora's partner list is small and changes rarely; one fetch serves every event
// in a warm container.
const PARTNERS_TTL_MS = 30 * 60 * 1000;
let partnersCache = null; // { list, fetchedAt }

export function resetPartnersCache() {
  partnersCache = null;
}

async function partnerNameFor(partnerId) {
  if (!partnersCache || Date.now() - partnersCache.fetchedAt >= PARTNERS_TTL_MS) {
    partnersCache = { list: await listPartners(), fetchedAt: Date.now() };
  }
  const hit = partnersCache.list.find((p) => p?.id === partnerId);
  return hit?.name ?? null;
}

/**
 * Resolve an Aurora partner's name to a Sundial_Dealer__c row in the tenant (D-085 am. 1).
 *
 * EXACT Name first (compared in code, because SOQL `=` ignores case), then the reviewed
 * alias CSV (lib/dealer-aliases.js, generated from docs/integrations/dealer-aliases.csv)
 * and an exact match on the canonical name it gives. NEVER a guess: two rows with one
 * name, or no row at all, is unresolved, and the caller leaves Dealer__c null with a
 * warning. Never throws — a dealer lookup must not fail a signed sale.
 *
 * Only a PARTNER name is looked up. An owner's personal name or a raw id is not a dealer
 * organization, and matching one to a dealer row would be a guess.
 *
 * @returns {Promise<{ dealer: {Id: string, Name: string}|null, via: "name"|"alias"|null, warnings: string[] }>}
 */
export async function resolveSundialDealer(partnerName, tenantId) {
  const warnings = [];
  const name = cleanStr(partnerName);
  if (!name) return { dealer: null, via: null, warnings };
  const canonical = resolveDealerAlias(name);
  const names = [...new Set([name, canonical].filter(Boolean))];
  let rows;
  try {
    rows = await sfQuery(
      `SELECT Id, Name FROM Sundial_Dealer__c WHERE Client__c = '${soqlEscapeString(tenantId)}' ` +
        `AND Name IN (${names.map((n) => `'${soqlEscapeString(n)}'`).join(", ")})`
    );
  } catch (e) {
    warnings.push(`Could not look up a Sundial dealer for Aurora partner "${name}": ${e?.message || e} — Dealer__c left blank.`);
    return { dealer: null, via: null, warnings };
  }
  for (const [want, via] of [[name, "name"], [canonical, "alias"]]) {
    if (!want) continue;
    const hits = (rows || []).filter((r) => cleanStr(r?.Name) === want);
    if (hits.length === 1) return { dealer: { Id: hits[0].Id, Name: hits[0].Name }, via, warnings };
    if (hits.length > 1) {
      warnings.push(`${hits.length} Sundial dealers are named "${want}" — Dealer__c left blank rather than picking one. Merge or rename the duplicates, then set the dealer on the customer.`);
      return { dealer: null, via: null, warnings };
    }
  }
  warnings.push(
    `Aurora partner "${name}" matches no Sundial dealer in this tenant (exact Name or dealer-aliases.csv) — ` +
      "Dealer__c left blank. Create the dealer, or add the spelling to docs/integrations/dealer-aliases.csv, " +
      "then set the dealer (or a Sales Rep) on the customer: a deal with no dealer has no commission terms."
  );
  return { dealer: null, via: null, warnings };
}

/**
 * Lead_Source__c for an auto-created customer (D-085 am. 1). The value is the resolved
 * dealer's Name, else the raw partner name. Written as the org spells it when the
 * picklist has it; written as-is when the describe says the picklist is UNRESTRICTED
 * (Tim is unrestricting it); otherwise today's match-or-skip — skipped, warned, noted —
 * because a restricted picklist rejects an unknown value and would fail the insert.
 *
 * @returns {{ value: string|null, warning: string|null, note: string|null }}
 */
export function buildLeadSource(wanted, schema) {
  const raw = cleanStr(wanted);
  if (!raw) return { value: null, warning: null, note: null };
  if (!schema.has("Lead_Source__c")) {
    return { value: null, warning: "Salesforce has no field Lead_Source__c — value not written.", note: null };
  }
  const matched = matchPicklist(raw, schema.picklistValues("Lead_Source__c"));
  if (matched) return { value: matched, warning: null, note: null };
  // Unknown restriction = restricted: the safe reading of a describe we cannot see.
  const restricted = typeof schema.isRestricted === "function" ? schema.isRestricted("Lead_Source__c") !== false : true;
  if (!restricted) return { value: raw, warning: null, note: null };
  return {
    value: null,
    warning: `Lead_Source__c has no "${raw}" value and the picklist is restricted — left unset. Add the value, or unrestrict the picklist (TASKS.md).`,
    note: `Lead source (not in picklist): ${raw}`,
  };
}

/**
 * Work out who the dealer is.
 *
 * Preference order, best evidence first:
 *   1. partner_id -> the partner's NAME (Aurora "partner" == external dealer org)
 *   2. owner_id   -> the owning USER's name (a person, not the firm, but useful)
 *   3. whatever raw ids exist
 *
 * NEVER throws and never fails the import: attribution is a nice-to-have, and a
 * 403 on these endpoints (not provisioned for our key) simply degrades to raw ids
 * plus a warning. The ids always land in the import notes either way.
 *
 * @returns {Promise<{ name: string|null, source: "partner"|"owner"|"raw"|null, warnings: string[] }>}
 *   `source` says what KIND of name it is — only a "partner" name is a dealer organization.
 */
export async function resolveDealer(project) {
  const warnings = [];
  const partnerId = cleanStr(project?.partner_id);
  const ownerId = cleanStr(project?.owner_id);

  if (partnerId) {
    try {
      const name = await partnerNameFor(partnerId);
      if (name) return { name, source: "partner", warnings };
      warnings.push(
        `Aurora partner_id ${partnerId} is not in the tenant's partner list — dealer name unresolved.`
      );
    } catch (e) {
      warnings.push(
        e instanceof AuroraError && e.notProvisioned
          ? `Aurora List Partners is NOT PROVISIONED for our API key (403) — dealer attribution unavailable; raw ids kept in the import notes. Contact Aurora's account team.`
          : `Could not list Aurora partners: ${e?.message || e}`
      );
    }
  }

  if (ownerId) {
    try {
      const user = await getUser(ownerId);
      const name = [cleanStr(user?.first_name), cleanStr(user?.last_name)]
        .filter(Boolean)
        .join(" ");
      if (name) return { name, source: "owner", warnings };
    } catch (e) {
      warnings.push(
        e instanceof AuroraError && e.notProvisioned
          ? `Aurora Retrieve User is NOT PROVISIONED for our API key (403) — owner name unavailable.`
          : `Could not retrieve Aurora user ${ownerId}: ${e?.message || e}`
      );
    }
  }

  // Nothing resolvable: fall back to the raw id so the record still points somewhere.
  const raw = partnerId || ownerId || null;
  if (raw) {
    warnings.push(
      `Dealer name could not be resolved; recorded the raw Aurora id "${raw}" instead.`
    );
  }
  return { name: raw, source: raw ? "raw" : null, warnings };
}

// --- helpers ----------------------------------------------------------------

function cleanStr(v) {
  return v == null ? "" : String(v).trim();
}

/**
 * Match a value against a picklist case/punctuation-insensitively and return the
 * org's CANONICAL casing (so "IL" writes the org's "Il", and "az" writes "AZ").
 */
export function matchPicklist(value, picklistValues = []) {
  const raw = cleanStr(value);
  if (!raw) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(raw);
  return picklistValues.find((v) => norm(v) === target) ?? null;
}

/** Build the "key: value" import-notes block. Returns "" when there is nothing to say. */
export function buildImportNotes({ project, agreementId, receivedAt, extras = [] }) {
  const lines = [];
  const add = (k, v) => {
    const s = cleanStr(v);
    if (s) lines.push(`${k}: ${s}`);
  };

  const loc = project?.location || {};
  add("Aurora project id", project?.id);
  add("Aurora project name", project?.name);
  add("Project type", project?.project_type);
  add("Aurora status", project?.status);
  add("Property address (raw)", loc.property_address);
  add("Country", loc.property_address_components?.country);
  add("Latitude", loc.latitude);
  add("Longitude", loc.longitude);
  add("Salutation", project?.customer_salutation);
  add("Mailing address", project?.mailing_address);
  add("Partner id", project?.partner_id);
  add("Owner (user) id", project?.owner_id);
  add("Team id", project?.team_id);
  add("Created in Aurora", project?.created_at);
  if (Array.isArray(project?.tags) && project.tags.length > 0) {
    add("Tags", project.tags.join(", "));
  }
  for (const line of extras) {
    const s = cleanStr(line);
    if (s) lines.push(s);
  }

  if (lines.length === 0) return "";
  const header =
    `Auto-created from Aurora signed agreement ${cleanStr(agreementId) || "(unknown)"} ` +
    `on ${cleanStr(receivedAt) || new Date().toISOString()}`;
  return [header, "", ...lines].join("\n");
}

/**
 * Map an Aurora project onto Sundial_Customer__c fields.
 *
 * @param {object} args
 * @param {object} args.project      - Retrieve Project response
 * @param {string} args.projectId    - the Aurora project id (upsert key)
 * @param {string} args.agreementId
 * @param {string} args.receivedAt
 * @param {string} args.tenantId     - Client__c
 * @param {string|null} args.dealerName
 * @param {{Id: string, Name: string}|null} [args.sundialDealer] - resolveSundialDealer's row
 * @param {string|null} [args.leadSourceName] - the dealer's Name, else the raw partner name
 * @param {object} args.schema       - { has(name), picklistValues(name), isRestricted(name) }
 * @returns {{ fields: object, warnings: string[] }}
 */
export function buildCustomerFields({
  project,
  projectId,
  agreementId,
  receivedAt,
  tenantId,
  dealerName,
  sundialDealer = null,
  leadSourceName = null,
  noteLines = [],
  schema,
}) {
  const warnings = [];
  const noteExtras = [];
  const fields = {};
  const set = (name, value) => {
    if (value === null || value === undefined || value === "") return;
    if (!schema.has(name)) {
      warnings.push(`Salesforce has no field ${name} — value not written.`);
      return;
    }
    fields[name] = value;
  };

  const first = cleanStr(project?.customer_first_name);
  const last = cleanStr(project?.customer_last_name);
  set("First_Name__c", first);
  set("Last_Name__c", last);

  // Name is what a human sees in every list. Fall back through the Aurora project
  // name to a last-resort label so an auto-created record is never anonymous.
  const name =
    [first, last].filter(Boolean).join(" ") ||
    cleanStr(project?.name) ||
    `Aurora Project ${cleanStr(projectId)}`;
  set("Name", name);

  set("Primary_Email__c", cleanStr(project?.customer_email));
  set("Primary_Phone__c", cleanStr(project?.customer_phone));

  // Address components are nested under `location` (verified against the spec).
  const comp = project?.location?.property_address_components || {};
  set("Street__c", cleanStr(comp.street_address));
  set("City__c", cleanStr(comp.city));
  set("Postal_Code__c", cleanStr(comp.postal_code));

  // State is a picklist: write it ONLY on a real match, else keep the raw value in
  // the notes. A junk picklist value would fail the whole insert.
  const region = cleanStr(comp.region);
  if (region) {
    const matched = matchPicklist(region, schema.picklistValues("State__c"));
    if (matched) {
      set("State__c", matched);
    } else {
      warnings.push(
        `Aurora region "${region}" is not in the State__c picklist — left unset; the raw value is in the import notes.`
      );
      noteExtras.push(`State (unmatched, from Aurora region): ${region}`);
    }
  }

  // Lead source NAMES THE DEALER (D-085 am. 1): the resolved dealer, else the partner.
  const lead = buildLeadSource(sundialDealer?.Name ?? leadSourceName, schema);
  if (lead.value) set("Lead_Source__c", lead.value);
  if (lead.warning) warnings.push(lead.warning);
  if (lead.note) noteExtras.push(lead.note);
  noteExtras.push(...noteLines);

  set("Active__c", true);
  set("Client__c", tenantId);
  // Aurora's own name for the dealer, kept as before — the raw evidence.
  set(F_DEALER_NAME, dealerName);
  // The Sundial dealer (D-085 am. 1): the deal's commercial terms come from it. Unresolved
  // stays null — the warning (from resolveSundialDealer) goes in the notes too.
  if (sundialDealer?.Id) set("Dealer__c", sundialDealer.Id);

  // Pipeline position — identical to what a matched customer gets on `signed`,
  // via the one shared helper so the two paths can't drift.
  const pipeline = buildSignedPipelineFields(schema);
  Object.assign(fields, pipeline.fields);
  warnings.push(...pipeline.warnings);
  noteExtras.push(...pipeline.notes);

  const notes = buildImportNotes({ project, agreementId, receivedAt, extras: noteExtras });
  set(F_IMPORT_NOTES, notes);

  return { fields, warnings };
}

/**
 * Create (or converge on) the customer for an Aurora project.
 *
 * IDEMPOTENT BY CONSTRUCTION: a Salesforce upsert keyed on Aurora_Project_ID__c
 * (flagged External ID, verified 2026-08-07). Duplicate signed deliveries and
 * concurrent workers therefore produce exactly ONE record — no SELECT-then-create
 * race. The external id is passed as the upsert key, never inside the field map.
 *
 * @returns {Promise<{ id: string, created: boolean, warnings: string[], dealerName: string|null }>}
 */
export async function createCustomerFromAuroraProject({
  project,
  projectId,
  agreementId,
  receivedAt,
  schema,
}) {
  const tenantId = await resolveTenantId();
  const dealer = await resolveDealer(project);
  const partnerName = dealer.source === "partner" ? dealer.name : null;
  const sundial = partnerName
    ? await resolveSundialDealer(partnerName, tenantId)
    : {
        dealer: null, via: null,
        warnings: dealer.name
          ? [`"${dealer.name}" is not an Aurora partner name (no partner on the project), so no Sundial dealer was looked up — Dealer__c left blank.`]
          : [],
      };

  const { fields, warnings } = buildCustomerFields({
    project,
    projectId,
    agreementId,
    receivedAt,
    tenantId,
    dealerName: dealer.name,
    sundialDealer: sundial.dealer,
    leadSourceName: partnerName,
    schema,
    noteLines: sundial.warnings.map((w) => `Dealer (unresolved): ${w}`),
  });

  const result = await sfUpsertRecord(
    CUSTOMER_SF_OBJECT,
    EXTERNAL_ID_FIELD,
    projectId,
    fields
  );

  return {
    id: result.id,
    created: result.created,
    dealerName: dealer.name,
    dealerId: sundial.dealer?.Id ?? null,
    warnings: [...dealer.warnings, ...sundial.warnings, ...warnings],
  };
}
